---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-06-ticket-retired-operation-fingerprints

English | [中文](2026-11-06-ticket-retired-operation-fingerprints.zh.md)

## Summary

Adds optional `retiredRequests` to Ticket operation records: the settlement tombstone keeps one request fingerprint per retired operation id, index for index.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-06-ticket-retired-operation-fingerprints
baseline: false
changes:
  - root: "event:ticket/state"
    previous: "2026-11-06-ticket-settled-operation-compaction"
    after: "25fef18d9abece359bfd18f188ac1b218cfa5c9520a916eca2a6ef795776311f"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Records without the field remain valid; a reader of this version accepts both forms and acknowledges any same-attempt retry of an operation in an older tombstone, as before. Writers emit the field only when every retired id has a fingerprint, and replay rejects a list whose length differs from `retiredIds`. An older reader's strict Ticket schema refuses an event carrying the field, reports a Ticket recovery failure for that root and keeps its known scopes reserved, so it fails closed instead of misreading state.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/ticket/tests: review-r5-idempotency.spec.ts R5-m1 (changed retry after replay returns TICKET_OPERATION_CONFLICT) and review-r5-regressions.spec.ts R5-m1 (fingerprint count equals retired id count) pass.

<a id="dev-note"></a>
## Dev Note

None.
