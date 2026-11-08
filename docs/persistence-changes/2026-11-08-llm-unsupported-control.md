---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-08-llm-unsupported-control

English | [中文](2026-11-08-llm-unsupported-control.zh.md)

## Summary

Adds the optional unsupportedControl field to the persisted LlmFailure, naming the refused request control and a closed reason.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-08-llm-unsupported-control
baseline: false
changes:
  - root: "event:assistant/attempt"
    previous: "2026-09-16-session-format-v4"
    after: "59d5e0bb1dd9a1fcfda395be3d7fcc4a29601693e321c754785d79a9f8e4b059"
    decision: same-version
  - root: "event:assistant/message"
    previous: "2026-09-16-session-format-v4"
    after: "a4602b43c6d5c0869982a422103425bb6b7889e2da3477ffed2ce82421684ee0"
    decision: same-version
  - root: "event:llm/retry"
    previous: "2026-09-14-image-offload"
    after: "c30f7baa88c5a378571cb8516c7fb8fde457886aacacd19c6a3bb446c1d1af77"
    decision: same-version
  - root: "event:turn/end"
    previous: "2026-09-16-session-format-v4"
    after: "4b511bc7493a9cf5aa5d861f246266bd0482ce66c383e1711e5d1fd67227a0a3"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid because the field is optional. Readers of earlier records see no field. Older readers of new records ignore the unknown optional property. Only UNSUPPORTED_CONTROL failures write it, and no consumer treats absence as support. Session format version and generations are unchanged.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/llm/llm packages/llm/llm-pi-ai packages/llm/llm-deepseek packages/core/agent-loop: adapter-failure, service, controls and request-reconstruction specs pass, including a malformed carrier falling back to UNKNOWN.

<a id="dev-note"></a>
## Dev Note

None.
