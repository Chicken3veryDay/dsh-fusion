"""Project the keyless refusal of an unsupported request control through the real Python SDK."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from deepseek_harness import DeepSeekHarness

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / 'apps' / 'cli' / 'lib' / 'bin.js'
SCENARIO = ROOT / 'snapshots' / 'sdk' / 'account-control-refusal'

@pytest.mark.skipif(not CLI.exists(), reason='requires the built dsh profile runtime')
def test_account_control_refusal_snapshot(tmp_path: Path) -> None:
    home = tmp_path / 'home'
    home.mkdir()
    credentials = home / '.credentials.yaml'
    credentials.write_text(json.dumps({'version': 1, 'refs': {}, 'records': {
        'llm-pi-ai/openai': {'kind': 'grant', 'payload': {
            'type': 'api_key', 'key': 'synthetic-session-access',
        }},
    }}))
    credentials.chmod(0o600)
    with DeepSeekHarness(
        dsh_bin=str(CLI),
        dsh_home=str(home),
        cwd=str(tmp_path),
        profile='sdk',
        patches=(str(SCENARIO / 'cordis.yml'), str(SCENARIO / 'cordis.snapshot.yml')),
        provider='openai',
        model='gpt-5.5',
        env={'DSH_TELEMETRY_DISABLED': '1', 'DSH_SNAPSHOT': 'replay'},
    ) as harness:
        result = harness.run('Say hello.')
    ending = next(event for event in reversed(result.events) if event['type'] == 'turn/end')
    actual = {
        'final_response': result.final_response,
        'finish_reason': result.finish_reason,
        'reason': ending['data']['reason'],
        'event_types': [event['type'] for event in result.events],
        'user_input': [
            event['data']['content'] for event in result.events
            if event['type'] == 'user/message' and event['data']['source']['kind'] == 'user'
        ],
        'outbound_requests': (home / 'account-requests.jsonl').read_text(),
    }
    expected = Path(__file__).with_name('expected') / 'account-control-refusal.json'
    assert actual == json.loads(expected.read_text())
