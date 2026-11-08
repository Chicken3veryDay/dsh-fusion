---
kind: upgrade-guide
description: "Workflow calls through the Script SDK emit durable run records in their calling Agent Session."
---

# Workflow records for Script SDK calls

English | [中文](guide.zh.md)

## Change

Agent-owned `tools.workflow(...)` calls inside `run_code` now emit the same four `tool-workflow/*` Session event types as direct Workflow calls. Consumers that assume nested Workflow calls have no durable run records must handle these events. A run receives its terminal record only after disposal succeeds; a background job can report a settled execution result while a cleanup failure leaves its Workflow record open. Existing event payloads and committed Session generations are unchanged.

## Migration

1. In custom Session consumers, identify Workflow runs by `runId`, independently of transport call nesting. Use the existing run-start, member-start, member-end, and run-end records rather than deriving duplicate runs from nested tool rows.
2. Run a Workflow through `tools.workflow(...)` in `run_code` and confirm its independent Workflow card shows the child and remains available after reloading the parent Session. Existing logs without these records cannot reconstruct them; no historical data is rewritten.
