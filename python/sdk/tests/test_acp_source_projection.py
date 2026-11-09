"""Source annotations and generated ACP context events pass through the Python SDK reader unchanged."""
from __future__ import annotations

import json
import sys
from pathlib import Path

from deepseek_harness import DeepSeekHarness

EXPECTED = Path(__file__).parent / "expected" / "acp-source-projection.json"
# Session log the shipped `dsh --profile acp` composition wrote in the keyless recorded-session snapshot.
PRODUCT_SESSION = Path(__file__).parents[3] / "snapshots" / "acp" / "context-instructions" / "session.v4.jsonl"

RUNTIME = """
import json
import os

def notify(method, params):
    print(json.dumps({"jsonrpc": "2.0", "method": method, "params": params}), flush=True)

for line in __import__("sys").stdin:
    message = json.loads(line)
    if message["method"] == "initialize":
        result = {"serverInfo": {"name": "acp-source-fixture"}}
    elif message["method"] == "session/query":
        session_id = message["params"]["sessionId"]
        notify("session.event", {"sessionId": session_id, "event": {
            "type": "agent/inbox/spliced", "seq": 0, "time": 0,
            "data": {"target": "next-turn", "start": 0, "inserted": [{"id": "accepted"}]}}})
        notify("session.status", {"sessionId": session_id, "status": "running"})
        print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": {"kind": "prompt", "messageId": "accepted"}}), flush=True)
        notify("session.event", {"sessionId": session_id, "event": {"type": "turn/start", "seq": 1, "time": 0, "data": {"turn": 0}}})
        seq = 2
        for event in json.loads(os.environ["SCRIPTED_EVENTS"]):
            notify("session.event", {"sessionId": session_id, "event": {**event, "seq": seq, "time": 0}})
            seq += 1
        notify("session.event", {"sessionId": session_id, "event": {"type": "assistant/message", "seq": seq, "time": 0,
            "data": {"message": {"role": "assistant", "content": [{"type": "text", "text": "done"}]}}}})
        notify("session.event", {"sessionId": session_id, "event": {"type": "turn/end", "seq": seq + 1, "time": 0,
            "data": {"turn": 0, "reason": {"kind": "completed"}}}})
        notify("session.status", {"sessionId": session_id, "status": "idle"})
        continue
    elif message["method"] == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": {}}), flush=True)
        break
    else:
        raise RuntimeError("Unexpected protocol method")
    print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}), flush=True)
"""


def test_acp_input_annotation_unknown_channel_and_packet_are_preserved(tmp_path: Path) -> None:
    expected = json.loads(EXPECTED.read_text(encoding="utf-8"))
    script = tmp_path / "acp_runtime.py"
    script.write_text(RUNTIME.strip(), encoding="utf-8")
    with DeepSeekHarness(
        _launch_args=(sys.executable, str(script)), cwd=str(tmp_path),
        env={"SCRIPTED_EVENTS": json.dumps(expected["events"])},
    ) as harness:
        result = harness.run([{"type": "text", "text": "read the scripted events"}], session_id="sdk-acp-source")
    received = [event for event in result.events if event["type"] == "user/message"]
    assert [{key: value for key, value in event.items() if key not in ("seq", "time")} for event in received] == expected["events"]
    projection = [
        {
            "id": event["data"]["id"],
            "authority": event["data"]["source"]["kind"],
            "input": event["data"]["source"].get("input"),
            "packet": event["data"]["source"]["kind"] == "acp-context",
        }
        for event in received
    ]
    assert projection == expected["projection"]


def test_acp_product_session_output_keeps_each_source_kind_and_authority(tmp_path: Path) -> None:
    logged = [json.loads(line) for line in PRODUCT_SESSION.read_text(encoding="utf-8").splitlines() if line]
    events = [event for event in logged if event["type"] == "user/message"]
    script = tmp_path / "acp_runtime.py"
    script.write_text(RUNTIME.strip(), encoding="utf-8")
    with DeepSeekHarness(
        _launch_args=(sys.executable, str(script)), cwd=str(tmp_path),
        env={"SCRIPTED_EVENTS": json.dumps(events)},
    ) as harness:
        result = harness.run([{"type": "text", "text": "read the product events"}], session_id="sdk-acp-product")
    received = [event for event in result.events if event["type"] == "user/message"]
    assert [{key: value for key, value in event.items() if key not in ("seq", "time")} for event in received] == events
    assert [event["data"]["source"]["kind"] for event in received] == ["user", "agent-instructions", "acp-context", "runtime-context"]
    input_message, instructions, packet, runtime = (event["data"] for event in received)
    assert input_message["source"] == {"kind": "user", "input": {"kind": "acp"}}
    assert instructions["source"]["baseline"] is True
    assert packet["source"]["recipient"] == "acp-automation"
    assert packet["source"]["latestInput"] == input_message["id"]
    # The goal fact arrives as a runtime-context section, a snapshot that carries no ACP channel or authority.
    assert runtime["source"]["kind"] == "runtime-context" and runtime["source"]["form"] == "snapshot"
    assert "input" not in runtime["source"]
    assert {section["name"]: section["text"] for section in runtime["source"]["sections"]}["acp:goal"] == "Goal: none."
