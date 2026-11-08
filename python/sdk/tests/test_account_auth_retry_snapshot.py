"""Project real pi-ai authentication failure and normal retry through the shipped SDK profile."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from deepseek_harness import DeepSeekHarness

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / 'apps' / 'cli' / 'lib' / 'bin.js'
SCENARIO = ROOT / 'snapshots' / 'sdk' / 'account-auth-retry'


def capture_auth_retry(tmp_path: Path) -> dict:
    """Run with an isolated synthetic grant and return stable SDK observations."""
    home = tmp_path / 'home'
    home.mkdir()
    credentials = home / '.credentials.yaml'
    credentials.write_text(json.dumps({'version': 1, 'refs': {}, 'records': {
        'llm-pi-ai/openai': {'kind': 'grant', 'payload': {
            'type': 'oauth', 'access': 'synthetic-expired', 'refresh': 'synthetic-refresh',
            'expires': 0, 'clientId': 'synthetic-issued-client',
        }},
    }}))
    credentials.chmod(0o600)
    with DeepSeekHarness(
        dsh_bin=str(CLI), dsh_home=str(home), cwd=str(tmp_path), profile='sdk',
        patches=(str(SCENARIO / 'cordis.yml'), str(SCENARIO / 'cordis.snapshot.yml')),
        provider='openai', model='gpt-5.5',
        env={'DSH_TELEMETRY_DISABLED': '1', 'DSH_SNAPSHOT': 'replay'},
    ) as harness:
        result = harness.run('Say hello.')
    notification_events = [
        notification.payload['event'] for notification in result.notifications
        if notification.method == 'session.event'
    ]
    for secret in ['synthetic-expired', 'synthetic-refresh', 'sk-synthetic-fresh-binding', 'synthetic-issued-client']:
        assert secret not in json.dumps(result.events)
        assert secret not in json.dumps(notification_events)
    ending = next(event for event in reversed(result.events) if event['type'] == 'turn/end')
    return {
        'final_response': result.final_response,
        'finish_reason': result.finish_reason,
        'reason': ending['data']['reason'],
        'event_types': [event['type'] for event in result.events],
        'notification_event_types': [event['type'] for event in notification_events],
        'retry_failures': [event['data']['failure'] for event in result.events if event['type'] == 'llm/retry'],
        'outbound_requests': [json.loads(line) for line in (home / 'auth-requests.jsonl').read_text().splitlines()],
    }


@pytest.mark.skipif(not CLI.exists(), reason='requires the built dsh profile runtime')
def test_account_auth_retry_snapshot(tmp_path: Path) -> None:
    actual = capture_auth_retry(tmp_path)
    expected = Path(__file__).with_name('expected') / 'account-auth-retry.json'
    assert actual == json.loads(expected.read_text())
