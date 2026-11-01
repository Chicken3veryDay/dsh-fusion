---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-01-retained-participants

English | [中文](2026-11-01-retained-participants.zh.md)

## Summary

Adds required log-only retained runtime ownership, immutable Fusion roster and participant establishment records. These records grant no activation authority.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-01-retained-participants
baseline: false
changes:
  - root: "event:agent/runtime-owner"
    previous: null
    after: "e294e49cea481ff4004f5b3ec405c8bcf535185314d7658f9377a00526ddbca2"
    decision: same-version
  - root: "event:fusion/participant-established"
    previous: null
    after: "33ec8821f825146667b0f5b98d8e28fc93dfbc5049cfada6c930b9634cfe053d"
    decision: same-version
  - root: "event:fusion/roster"
    previous: null
    after: "4bcabd32e675d9dce15ec5bba10ed87ae579a70376109c8071c7ab8987aee8ee"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Both reader directions were executed against preserved upstream tree d3c6ee1d1f0ec8b71c92e1b62d0cf9a8d6553bf8. Its physical JSONL parser/writer and stored-event validator are byte-identical to current source; the test loads the preserved sources with the preserved known-event set. Upstream-encoded stock records pass the current parser and stock Agent resume; stock records remain unchanged. Each new required record independently and the combined managed root are rejected by the upstream stored-event validator before managed activation. Physical scanLog alone does not refuse unknown required records: refusal belongs to validateStoredEvents in the persistence provider read path. Current real JSONL recovery refuses missing, malformed and duplicate ownership/roster evidence and malformed/duplicate establishment evidence. An absent establishment record denotes recoverable incomplete provisioning; an established participant missing on disk refuses replacement. Required discriminators suffice for safe refusal, so the writer remains V4. No locked history or released schema is changed.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/fusion-participants/tests/lifecycle.spec.ts: 23 passed, exit 0 (parsers-final-2.log). Includes preserved upstream parser/writer + stored validator, each required event independently, stock resume and eight durable payload corruption cases. SDK recorded-session and packaged Python sdk-retained replay passed with zero requests and queued input unclaimed. Evidence: dsh-p03-completion-r1/sdk-final-2.log and python-retained-final-2.log. The Python packaging command itself failed after producing the tested executable due to unrelated tslib lock-integrity mismatch; this acknowledgement does not certify packaging or independent review.

<a id="dev-note"></a>
## Dev Note

None.
