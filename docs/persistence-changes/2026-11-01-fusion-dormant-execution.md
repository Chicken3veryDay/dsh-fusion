---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-01-fusion-dormant-execution

English | [中文](2026-11-01-fusion-dormant-execution.zh.md)

## Summary

Adds required log-only Fusion execution incarnation, grant, revoke, effect-start, producer-settlement and independent-reconciliation facts.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-01-fusion-dormant-execution
baseline: false
changes:
  - root: "event:fusion/effect-reconciled"
    previous: null
    after: "0b74adcfdeb1e21f5c63655b06370a71873a7c87c7c51b90f39d02e7b21531f1"
    decision: same-version
  - root: "event:fusion/effect-settled"
    previous: null
    after: "2ef5bf51ec3e9de6ff96b6fa97a39f0811663cd60b265a3da9a1fabd12935344"
    decision: same-version
  - root: "event:fusion/effect-started"
    previous: null
    after: "8dc5ab71c48f8234fdfba2162b2d45780e9abc12b73f2dea357a626cf4a515db"
    decision: same-version
  - root: "event:fusion/execution-granted"
    previous: null
    after: "c3285588abb3a912538797c61a7a0750f42c7850dd6e370d3d675eb582037be0"
    decision: same-version
  - root: "event:fusion/execution-opened"
    previous: null
    after: "21e1b893af790eb27c197f10706f9dc1035978b96f7e4a36f81092f9b98f2541"
    decision: same-version
  - root: "event:fusion/execution-revoked"
    previous: null
    after: "6873557fc1f0c7e02c51e17b5654374f92522a96a1af298fd8f7938ffa92ab2c"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing stock logs and prior dormant Fusion histories remain readable. Recovery initializes authority closed and never replays an effect. All six new event discriminators are required-on-read, so older readers refuse managed histories rather than infer authority or completion. No existing event or released physical format changes.

<a id="verification"></a>
## Verification

Focused execution and projection tests exercise durable starts, final dispatch fencing, draining and deterministic checkpoint replay. Dedicated process fixtures exercise uncertainty retention, post-exit lock acquisition and reconciliation without producer settlement. The preserved upstream parser refuses each new required discriminator; SDK replay exercises closed production publication with zero requests and claims.

<a id="dev-note"></a>
## Dev Note

None.
