---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-03-ticket-state

English | [中文](2026-11-03-ticket-state.zh.md)

## Summary

Adds the durable ticket/state event root for the experimental Ticket coordination service.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-03-ticket-state
baseline: false
changes:
  - root: "event:ticket/state"
    previous: null
    after: "56644029af422bde16ac0be0d8bbb2ef6f8fc73309ed740395c305accb155a93"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

This is a new event root with no existing records to decode. Readers reject malformed snapshots through the Ticket projection schema, and later revisions remain whole-value snapshots with contiguous per-ticket revisions.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/ticket/tests/ticket.spec.ts

<a id="dev-note"></a>
## Dev Note

None.
