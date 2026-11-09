---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-08-acp-input-context

English | [中文](2026-11-08-acp-input-context.zh.md)

## Summary

Adds an optional ACP input annotation to the direct-user message source and a generated, attribution-only acp-context source kind.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-08-acp-input-context
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-06-context-grant-supersedes"
    after: "2278b039eb79c79ee88dcac9e47ffce004d9aa4053d3ace132cf9f05426e85e7"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-06-context-grant-supersedes"
    after: "63d4d8aaeb10e857369c5216809834980e2e62e9992571422fb8a61c6387736d"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-06-context-grant-supersedes"
    after: "1496b20df0126e0a752c3e95d77c5851b23ce6a32d78cfcb526a261b88ccd41b"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-06-context-grant-supersedes"
    after: "10004363f33e1c9c1187dfd8c74b1a149d969efffda88891c610debb8f16015b"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid: a user source without input means no channel is recorded, and no reader infers an ACP origin, task, or role from it. Older readers handle new records by treating input as an unread optional property on an unchanged user kind, so authority stays with source.kind and the exact content; they preserve acp-context as an unknown attribution kind with its JSON metadata, because the kind is qualified with persistenceAttribution and imposes no validation, replay, or authority. Auto-review classifies it as a fact and keeps a tagged input a user instruction. Only the ACP plugin inspects its own acp-context kind, to suppress a repeated packet; after resume of old history it reports the latest input as unknown until a tagged input arrives.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/session/session-persistence-jsonl/tests/native-source-admission.spec.ts: 48 tests passed, including exact preservation of tagged, unknown-channel, acp-context, and untagged sources. pnpm exec vitest run packages/sdk/client/tests/acp-source-projection.spec.ts: 2 tests passed; uv run pytest python/sdk/tests/test_acp_source_projection.py: 1 test passed. pnpm exec vitest run packages/acp/acp/tests/context.spec.ts: 11 tests passed, including old untagged history resumed under the new writer. pnpm exec vitest run packages/experimental/auto-review/tests/auto-review.spec.ts: 43 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
