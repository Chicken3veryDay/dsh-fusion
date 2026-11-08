"""Project the keyless refusal of an official DeepSeek temperature through the real Python SDK."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from deepseek_harness import DeepSeekHarness

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / 'apps' / 'cli' / 'lib' / 'bin.js'
SCENARIO = ROOT / 'snapshots' / 'sdk' / 'deepseek-temperature-refusal'


@pytest.mark.skipif(not CLI.exists(), reason='requires the built dsh profile runtime')
def test_deepseek_temperature_refusal_snapshot(tmp_path: Path) -> None:
    home = tmp_path / 'home'
    home.mkdir()
    with DeepSeekHarness(
        dsh_bin=str(CLI),
        dsh_home=str(home),
        cwd=str(tmp_path),
        profile='sdk',
        patches=(str(SCENARIO / 'cordis.yml'), str(SCENARIO / 'cordis.snapshot.yml')),
        provider='deepseek-official',
        model='deepseek-flash',
        env={
            'DSH_TELEMETRY_DISABLED': '1',
            'DSH_SNAPSHOT': 'replay',
            # Synthetic key the scenario's API-key route resolves; the fetch trap rejects every request.
            'DEEPSEEK_API_KEY': 'snapshot-replay-key',
            # Keep the developer's endpoint override out of the scenario.
            'DEEPSEEK_BASE_URL': '',
        },
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
        'outbound_requests': (home / 'deepseek-requests.jsonl').read_text(),
    }
    expected = Path(__file__).with_name('expected') / 'deepseek-temperature-refusal.json'
    assert actual == json.loads(expected.read_text())
