---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-06-context-core-budget

English | [中文](2026-11-06-context-core-budget.zh.md)

## Summary

Records the byte charge of eager context grants in the optional context-grant source field coreBytes.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-06-context-core-budget
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-06-context-tree-sources"
    after: "2f8ee255ee2c2978dce5667721de59f0d87a7af418c736271361465f64140f5d"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-06-context-tree-sources"
    after: "d224a9637a3bdc88943d15a9c8f3dbe551a4d320b2965c2521a1f6a113d4d24f"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-06-context-tree-sources"
    after: "d69f11beabb938e9249b8095fd9f1a989f418560e9b7b71a7194fe196c0b8a68"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-06-context-tree-sources"
    after: "75159c38cc4fc8177f26157c0d8ba68cf7854d618c4296e1eabdf4493b2e8bb0"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing messages without coreBytes remain readable. Because earlier writers did not distinguish eager grants from explicit loads, new eager grants wait until those messages are revoked. New explicit loads record zero; eager grants record their bytes. Older readers ignore the optional field and continue to load and revoke grants. New readers reconstruct charges from logged, queued, and claimed messages. The private contextTree projection state version changes so incompatible checkpoints refold from the Session log. No Session format version changes.

<a id="verification"></a>
## Verification

The context-tree regression cases cover core selection replacement while queued, claimed, and logged, budget release at compaction, legacy grants, serialized checkpoint plus suffix replay, and regrouped section and tool reloads.

<a id="dev-note"></a>
## Dev Note

None.
