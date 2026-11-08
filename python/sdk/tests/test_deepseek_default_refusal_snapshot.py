"""Project the keyless refusal of an official DeepSeek temperature on the default catalog through the real Python SDK."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from deepseek_harness import DeepSeekHarness

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / 'apps' / 'cli' / 'lib' / 'bin.js'
SCENARIO = ROOT / 'snapshots' / 'sdk' / 'deepseek-default-refusal'


@pytest.mark.skipif(not CLI.exists(), reason='requires the built dsh profile runtime')
def test_deepseek_default_refusal_snapshot(tmp_path: Path) -> None:
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
            # Synthetic key the shipped API-key route resolves; the fetch trap serves only the listing.
            'DEEPSEEK_API_KEY': 'snapshot-replay-key',
            # Pin the public origin so the developer's endpoint override stays out of the default catalog.
            'DEEPSEEK_BASE_URL': 'https://api.deepseek.com/anthropic',
        },
    ) as harness:
        result = harness.run('Say hello.')
    work = [json.loads(line) for line in (home / 'deepseek-work.jsonl').read_text().splitlines()]
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
        # Credential reads and HTTP requests by phase: startup discovery, then nothing after the final control selection.
        'work_by_phase': {
            phase: [entry for entry in work if entry['phase'] == phase] for phase in ('startup', 'refusal')
        },
    }
    expected = Path(__file__).with_name('expected') / 'deepseek-default-refusal.json'
    assert actual == json.loads(expected.read_text())
