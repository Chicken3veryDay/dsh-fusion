"""Recorded retained lifecycles through the packaged SDK profile and real JSONL persistence."""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path


def smoke_sdk_fusion_delivery(executable: Path) -> None:
    """Restore both recorded Session roles across two complete Python SDK runtime processes."""
    from deepseek_harness import DeepSeekHarness

    repository = Path(__file__).resolve().parent.parent
    fixture = repository / "snapshots/sdk/fusion-delivery"
    expected = json.loads((repository / "scripts/snapshots/python-sdk-single-exe/fusion-delivery/result.json").read_text())
    evidence = None
    if os.environ.get("DSH_FUSION_DELIVERY_EVIDENCE"):
        evidence = Path(os.environ["DSH_FUSION_DELIVERY_EVIDENCE"])
        evidence.mkdir(parents=True, exist_ok=False)
    with tempfile.TemporaryDirectory(prefix="python-fusion-delivery-") as temporary:
        root = Path(temporary).resolve()
        home = root / "home"
        sessions = home / "sessions"

        def recorded(filename: str) -> list[dict[str, object]]:
            text = (fixture / filename).read_text()
            for token, value in (("{{session:1}}", "delivery-root"),
                                 ("{{session:2}}", "delivery-child"),
                                 ("{{message:1}}", "recorded-delivery-message")):
                text = text.replace(token, value)
            return [json.loads(line) for line in text.splitlines()]

        originals: dict[str, list[dict[str, object]]] = {}
        for index, session_id in enumerate(("delivery-root", "delivery-child")):
            suffix = ".1" if index else ""
            originals[session_id] = recorded(f"recovered{suffix}.expected.jsonl")
            rows = recorded(f"session{suffix}.v4.jsonl")
            physical = [rows[0], *({**row, "seq": i, "time": 1785097381465 + i}
                                   for i, row in enumerate(rows[1:]))]
            directory = sessions / "_no-cwd" / session_id
            directory.mkdir(parents=True)
            (directory / "session.v4.jsonl").write_text("".join(json.dumps(row) + "\n" for row in physical))
        patch = root / "delivery.patch.json"
        patch.write_text(json.dumps([
            {"id": "session-persistence-jsonl", "config": {"root": str(sessions), "compression": "none"}},
            {"id": "session-telemetry-otel", "disabled": True},
            {"id": "sdk-jsonrpc-server", "inject": ["sdkAppStartup", "loader", "fusionParticipants"], "config": {"queryCommandDefinitions": ["snapshot/delivery-fixture"]}},
            {"insert": [
                {"id": "delivery-guard", "name": str(fixture / "guard.mjs")},
                {"id": "delivery-registry", "name": "@deepseek-ai/dsh-agent-preset-registry", "config": {"default": "delivery-empty"}},
                {"id": "delivery-preset", "name": "@deepseek-ai/dsh-agent-preset", "config": {"id": "delivery-empty", "plugins": []}},
                {"id": "delivery-config", "name": str(repository / "packages/preset/fusion-config/lib/index.js"), "config": {"document": {
                    "credentialRef": "DELIVERY_TEST", "agentPreset": "delivery-empty", "providers": {}, "declarations": [], "bindings": [], "selections": [],
                    "metadataLimits": {"responseBytes": 32768, "totalBytes": 262144, "pages": 32, "timeoutMs": 5000},
                }}},
                {"id": "delivery-participants", "name": str(repository / "packages/experimental/fusion-participants/lib/index.js")},
                {"id": "delivery-fixture", "name": str(fixture / "runtime.mjs")},
            ]},
        ]))
        for process in range(2):
            with DeepSeekHarness(
                provider="deepseek-official", model="deepseek-v4-flash", cwd=str(root),
                dsh_bin=str(executable), dsh_home=str(home), patches=(str(patch),),
                env={"DSH_TELEMETRY_DISABLED": "1", "DSH_AGENTS_HOME": str(root / "agents")},
                request_timeout_seconds=60,
            ) as harness:
                result = harness.run("/delivery_fixture", session_id=f"controller-{process}")
                if evidence is not None:
                    (evidence / f"process-{process}.json").write_text(result.final_response)
                assert result.finish_reason == "completed", result
                assert json.loads(result.final_response) == expected, result.final_response
                done = [event for event in result.events if event.get("type") == "command/done"]
                assert len(done) == 1 and done[0]["data"]["kind"] == "success", done
        for session_id, original in originals.items():
            path = sessions / "_no-cwd" / session_id / "session.v4.jsonl"
            if evidence is not None:
                (evidence / f"{session_id}.jsonl").write_text(path.read_text())
            rows = [json.loads(line) for line in path.read_text().splitlines()]
            for row in rows[1:]:
                row.pop("seq", None)
                row.pop("time", None)
            if session_id == "delivery-root":
                # This runner owns two recoveries; the TypeScript oracle also owns shutdown recoveries.
                opened = [index for index, row in enumerate(original) if row["type"] == "fusion/execution-opened"]
                assert len(opened) == 6, opened
                original = original[:opened[1] + 1]
                for values in (rows, original):
                    identities = {row["data"]["incarnation"]: f"incarnation-{index}"
                                  for index, row in enumerate(row for row in values if row["type"] == "fusion/execution-opened")}
                    for row in values:
                        if row["type"] == "fusion/execution-opened":
                            data = row["data"]
                            data["incarnation"] = identities[data["incarnation"]]
                            if data["previous"] is not None:
                                data["previous"] = identities[data["previous"]]
                            data["openingId"] = "opening-" + data["incarnation"]
            assert rows == original, (session_id, rows, original)
