---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-06-context-map-claim-work

English | [中文](2026-11-06-context-map-claim-work.zh.md)

## Summary

Adds an optional `work` fingerprint to the `context-map/state` operation, written on `claim` so a restart can count curator runs started for the same work.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-06-context-map-claim-work
baseline: false
changes:
  - root: "event:context-map/state"
    previous: "2026-11-06-context-map-index-ack"
    after: "2c6d8e2433f44afffea786a0cc337c9d4af94de63680d567914cdea867d4646d"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records stay valid: the field is optional and absent from every earlier event. An older reader with a strict schema would reject a record that carries `work`; no earlier release ships this experimental package. A newer reader treats absence as no attempt recorded, and the projection state version rises to 3 so older checkpoints refold from the log.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/context-map/tests: all tests passed, including the claim-count replay and the retry bound across a service restart.

<a id="dev-note"></a>
## Dev Note

None.
