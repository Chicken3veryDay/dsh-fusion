---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-06-ticket-settled-operation-compaction

English | [中文](2026-11-06-ticket-settled-operation-compaction.zh.md)

## Summary

Adds optional attempt ownership and retired operation ids to Ticket operation records so settlement can compact request fingerprints while preserving operation-id refusals.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-06-ticket-settled-operation-compaction
baseline: false
changes:
  - root: "event:ticket/state"
    previous: "2026-11-04-ticket-v2-workstream"
    after: "472f18aaf968aa9f8452ed5a3778eea72b860f0f16765ff015054b1423d8f9c6"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

New readers accept historical records without these fields and retain their untagged operations. Tagged operations may be retired only into a record for the same settled attempt; replay rejects deletion without retained ids. Older Ticket readers use a strict operation schema and refuse records carrying the added fields before applying the snapshot, rather than dropping operation history or executing effects. SESSION_FORMAT_VERSION is unchanged; committed generations and finalized acknowledgements are unchanged.

<a id="verification"></a>
## Verification

The round-3 regression suite passes, including full Session replay after compaction and rejection of compaction that omits retired operation ids. The same regression suite against source extracted from the pinned base fails all finding cases. Historical canonical fingerprints remain covered by execution-lifecycle.spec.ts.

<a id="dev-note"></a>
## Dev Note

None.
