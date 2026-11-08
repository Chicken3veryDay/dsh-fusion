"""Project a rate-limited Claude account failing over to another account through both SDKs."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from deepseek_harness import DeepSeekHarness

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / 'apps' / 'cli' / 'lib' / 'bin.js'
SCENARIO = ROOT / 'snapshots' / 'sdk' / 'anthropic-account-pool'
ACCOUNTS = ('pool-a', 'pool-b')


def write_account(home: Path, account: str) -> None:
    """Write one 0600 credential document that holds only this account's synthetic grant."""
    document = home / 'accounts' / f'{account}.credentials.yaml'
    document.parent.mkdir(exist_ok=True)
    document.write_text(json.dumps({'version': 1, 'refs': {}, 'records': {
        'llm-pi-ai/anthropic': {'kind': 'grant', 'payload': {
            'type': 'oauth', 'access': f'sk-ant-oat-synthetic-{account}', 'refresh': f'synthetic-refresh-{account}',
            'expires': 4102444800000,
        }},
    }}))
    document.chmod(0o600)


def capture_account_pool(tmp_path: Path) -> dict:
    """Run the shipped profile with two synthetic accounts and retain stable observations."""
    home = tmp_path / 'home'
    home.mkdir()
    for account in ACCOUNTS:
        write_account(home, account)
    with DeepSeekHarness(
        dsh_bin=str(CLI), dsh_home=str(home), cwd=str(tmp_path), profile='sdk',
        patches=(str(SCENARIO / 'cordis.yml'), str(SCENARIO / 'cordis.snapshot.yml')),
        provider='anthropic', model='claude-haiku-4-5',
        env={'DSH_TELEMETRY_DISABLED': '1', 'DSH_SNAPSHOT': 'replay'},
    ) as harness:
        result = harness.run('Write the pool proof file using Script.')
    events = result.events
    notification_events = [
        item.payload['event'] for item in result.notifications if item.method == 'session.event'
    ]
    secrets = [f'sk-ant-oat-synthetic-{account}' for account in ACCOUNTS] + [
        f'synthetic-refresh-{account}' for account in ACCOUNTS
    ]
    for secret in secrets:
        assert secret not in json.dumps(events)
        assert secret not in json.dumps(notification_events)
    main = home / '.credentials.yaml'
    assert not main.exists() or 'llm-pi-ai/anthropic' not in main.read_text()
    requests = [json.loads(line) for line in (home / 'pool-requests.jsonl').read_text().splitlines()]
    system = next(event['data']['message'] for event in events if event['type'] == 'system/message')
    text = ''.join(block['text'] for block in system['content'])
    for request in requests:
        assert '\n\n'.join(request['system']) == text
        del request['system']
    digests = [request.pop('historyDigest') for request in requests]
    ending = next(event for event in reversed(events) if event['type'] == 'turn/end')
    return {
        'final_response': result.final_response,
        'finish_reason': result.finish_reason,
        'reason': ending['data']['reason'],
        'event_types': [event['type'] for event in events],
        'notification_event_types': [event['type'] for event in notification_events],
        'tool_names': [event['data']['name'] for event in events if event['type'] == 'tool/call'],
        'system_prefix': text.split('\n\n', 1)[0],
        'proof_file': (tmp_path / 'pool-proof.txt').read_text(),
        'retry_replays_identical_history': digests[0] == digests[1],
        'tool_result_changes_history': digests[2] != digests[1],
        'failed_attempts': [
            event['data']['stream'][-1]['chunk']['reason']['failure']
            for event in events
            if event['type'] == 'assistant/attempt'
        ],
        'outbound_requests': requests,
    }


@pytest.mark.skipif(not CLI.exists(), reason='requires the built dsh profile runtime')
def test_anthropic_account_pool_snapshot(tmp_path: Path) -> None:
    actual = capture_account_pool(tmp_path)
    expected = Path(__file__).with_name('expected') / 'anthropic-account-pool.json'
    assert actual == json.loads(expected.read_text())
