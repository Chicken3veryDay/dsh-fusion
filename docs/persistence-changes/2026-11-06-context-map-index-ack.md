---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-06-context-map-index-ack

English | [中文](2026-11-06-context-map-index-ack.zh.md)

## Summary

Records successful context-map curation with an explicit index-ack operation. Claims retain the last completed index digest; interrupted runs leave the index eligible for another attempt.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-06-context-map-index-ack
baseline: false
changes:
  - root: "event:context-map/state"
    previous: "2026-11-06-context-map-state"
    after: "6b52d5e9ddcd9dead0af596aac53170fba801bc1d174473837d8436f6f2cfc0d"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The snapshot fields and event version stay unchanged. Current readers accept existing operation kinds and treat legacy claim-time digests without an index-ack as incomplete. Older readers reject the unrecognized index-ack operation during strict operation validation instead of interpreting it as a completed edit. Downgrading a Session containing the new operation is unsupported; SESSION_FORMAT_VERSION is unchanged.

<a id="verification"></a>
## Verification

The context-map curator recovery regressions exercise interrupted partial runs at the step bound, on model failure, and during curator disposal and restart, followed by successful retry. The profile composition snapshot records indexChanged as true during an uncompleted first run. Projection recovery requires explicit acknowledgement before exposing a completed digest.

<a id="dev-note"></a>
## Dev Note

None.
