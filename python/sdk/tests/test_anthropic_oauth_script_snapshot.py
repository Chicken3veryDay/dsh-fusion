"""Project DSH-owned Anthropic OAuth inference and real Script execution through both SDKs."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from deepseek_harness import DeepSeekHarness

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / 'apps' / 'cli' / 'lib' / 'bin.js'
SCENARIO = ROOT / 'snapshots' / 'sdk' / 'anthropic-oauth-script'


def capture_oauth_script(tmp_path: Path) -> dict:
    """Run the shipped profile with synthetic OAuth and retain stable observations."""
    home = tmp_path / 'home'
    home.mkdir()
    credentials = home / '.credentials.yaml'
    credentials.write_text(json.dumps({'version': 1, 'refs': {}, 'records': {
        'llm-pi-ai/anthropic': {'kind': 'grant', 'payload': {
            'type': 'oauth', 'access': 'sk-ant-oat-synthetic-dsh', 'refresh': 'synthetic-refresh',
            'expires': 4102444800000,
        }},
    }}))
    credentials.chmod(0o600)
    with DeepSeekHarness(
        dsh_bin=str(CLI), dsh_home=str(home), cwd=str(tmp_path), profile='sdk',
        patches=(str(SCENARIO / 'cordis.yml'), str(SCENARIO / 'cordis.snapshot.yml')),
        provider='anthropic', model='claude-haiku-4-5',
        env={'DSH_TELEMETRY_DISABLED': '1', 'DSH_SNAPSHOT': 'replay'},
    ) as harness:
        result = harness.run('Write the proof file using Script.')
    events = result.events
    notification_events = [
        item.payload['event'] for item in result.notifications if item.method == 'session.event'
    ]
    for secret in ['sk-ant-oat-synthetic-dsh', 'synthetic-refresh']:
        assert secret not in json.dumps(events)
        assert secret not in json.dumps(notification_events)
    requests = [json.loads(line) for line in (home / 'oauth-requests.jsonl').read_text().splitlines()]
    system = next(event['data']['message'] for event in events if event['type'] == 'system/message')
    text = ''.join(block['text'] for block in system['content'])
    for request in requests:
        assert '\n\n'.join(request['system']) == text
        del request['system']
    ending = next(event for event in reversed(events) if event['type'] == 'turn/end')
    return {
        'final_response': result.final_response,
        'finish_reason': result.finish_reason,
        'reason': ending['data']['reason'],
        'event_types': [event['type'] for event in events],
        'notification_event_types': [event['type'] for event in notification_events],
        'tool_names': [event['data']['name'] for event in events if event['type'] == 'tool/call'],
        'system_prefix': text.split('\n\n', 1)[0],
        'proof_file': (tmp_path / 'oauth-proof.txt').read_text(),
        'outbound_requests': requests,
    }


@pytest.mark.skipif(not CLI.exists(), reason='requires the built dsh profile runtime')
def test_anthropic_oauth_script_snapshot(tmp_path: Path) -> None:
    actual = capture_oauth_script(tmp_path)
    expected = Path(__file__).with_name('expected') / 'anthropic-oauth-script.json'
    assert actual == json.loads(expected.read_text())
