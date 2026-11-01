"""Recorded retained lifecycles through the packaged SDK profile and real JSONL persistence."""
from __future__ import annotations

import json
import tempfile
from pathlib import Path


def smoke_sdk_retained(executable: Path) -> None:
    """Restore both recorded Session roles across two complete Python SDK runtime processes."""
    from deepseek_harness import DeepSeekHarness

    repository = Path(__file__).resolve().parent.parent
    fixture = repository / "snapshots/sdk/fusion-retained"
    expected = json.loads((repository / "scripts/snapshots/python-sdk-single-exe/fusion-retained/result.json").read_text())
    with tempfile.TemporaryDirectory(prefix="python-fusion-retained-") as temporary:
        root = Path(temporary).resolve()
        home = root / "home"
        sessions = home / "sessions"

        def recorded(filename: str) -> list[dict[str, object]]:
            text = (fixture / filename).read_text()
            for token, value in (("{{session:1}}", "retained-root"),
                                 ("{{session:2}}", "retained-child"),
                                 ("{{message:1}}", "recorded-history"),
                                 ("{{message:2}}", "recorded-queued")):
                text = text.replace(token, value)
            return [json.loads(line) for line in text.splitlines()]

        originals: dict[str, list[dict[str, object]]] = {}
        for index, session_id in enumerate(("retained-root", "retained-child")):
            suffix = ".1" if index else ""
            originals[session_id] = recorded(f"recovered{suffix}.expected.jsonl")
            rows = recorded(f"session{suffix}.v4.jsonl")
            physical = [rows[0], *({**row, "seq": i, "time": 1785097381465 + i}
                                   for i, row in enumerate(rows[1:]))]
            directory = sessions / "_no-cwd" / session_id
            directory.mkdir(parents=True)
            (directory / "session.v4.jsonl").write_text("".join(json.dumps(row) + "\n" for row in physical))
        patch = root / "retained.patch.json"
        patch.write_text(json.dumps([
            {"id": "session-persistence-jsonl", "config": {"root": str(sessions), "compression": "none"}},
            {"id": "session-telemetry-otel", "disabled": True},
            {"id": "sdk-jsonrpc-server", "config": {"queryCommandDefinitions": ["snapshot/retained-fixture"]}},
            {"insert": [{"id": "retained-fixture", "name": str(fixture / "runtime.mjs")}]},
        ]))
        for process in range(2):
            with DeepSeekHarness(
                provider="deepseek-official", model="deepseek-v4-flash", cwd=str(root),
                dsh_bin=str(executable), dsh_home=str(home), patches=(str(patch),),
                env={"DSH_TELEMETRY_DISABLED": "1", "DSH_AGENTS_HOME": str(root / "agents")},
                request_timeout_seconds=60,
            ) as harness:
                result = harness.run("/retained_fixture", session_id=f"controller-{process}")
                assert result.finish_reason == "completed", result
                assert json.loads(result.final_response) == expected, result.final_response
                done = [event for event in result.events if event.get("type") == "command/done"]
                assert len(done) == 1 and done[0]["data"]["kind"] == "success", done
        for session_id, original in originals.items():
            path = sessions / "_no-cwd" / session_id / "session.v4.jsonl"
            rows = [json.loads(line) for line in path.read_text().splitlines()]
            for row in rows[1:]:
                row.pop("seq", None)
                row.pop("time", None)
            assert rows == original, (session_id, rows, original)
