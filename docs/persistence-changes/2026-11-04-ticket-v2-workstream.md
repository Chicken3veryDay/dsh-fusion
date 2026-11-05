---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-04-ticket-v2-workstream

English | [中文](2026-11-04-ticket-v2-workstream.zh.md)

## Summary

Adds version 2 of the experimental ticket/state payload, the workstream-message attribution kind on user, developer, inbox-splice and title-request messages, and the new workstream/state event root.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-04-ticket-v2-workstream
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-01-fusion-dormant-delivery"
    after: "b13a808c5e495e918e8d16788b526b58fd733f6741d6d5a893c86842e95cb3bd"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-01-fusion-dormant-delivery"
    after: "d3624bfb4e0fe612cc6489e0e4237f84ee183f9d6dd013660218df9bfb8a063e"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-01-fusion-dormant-delivery"
    after: "bf10bc3133a22a4b9b1c0f081a41cb496726648c1f3b607ce317fed88aecdeaa"
    decision: same-version
  - root: "event:ticket/state"
    previous: "2026-11-03-ticket-state"
    after: "91ba8fa73daf7294d778944a6e02c9ab08f817b159d14395168df1c23b80a2b6"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-01-fusion-dormant-delivery"
    after: "22061fa35d6cd487aef34aa910f8b5f114f63d912c27623c556d63872a98b427"
    decision: same-version
  - root: "event:workstream/state"
    previous: null
    after: "e92da1a786b4ec10310e40ac99c319a93327b329651452d40be0e94d3f496d3d"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Ticket: ticket/state remains one event type discriminated by data.version. The version 1 alternative keeps its earlier shape except that report snapshots gain optional specRevision and attemptId; version 2 adds specification, attempts, candidates, checks, operations, missionPlans and assignment contribution. The Ticket package exists only on this branch, so no released log contains either version. The projection decodes both: version 1 is upgraded with empty specification lists and 'required'/'advisory' contribution defaults, and a version 1 event after a version 2 event for the same ticket fails the projection with 'Ticket event version cannot downgrade' (packages/experimental/ticket/src/projection.ts, applyProjectionEvent and upgradeLegacy). Workstream message source: workstream-message is a new producer-owned kind in the merge-extensible MessageSourceMap (packages/experimental/workstream/src/types.ts). It is not marked @persistenceAttribution, so this record is the explicit same-version review. Older readers: native source admission accepts any nonempty string kind except the retired 'plugin' wrapper (packages/session/session-format-v3-to-v4/src/message-sources.ts), and the JSONL store preserves an unknown kind and its metadata without the producer installed (packages/session/session-persistence-jsonl/tests/native-source-admission.spec.ts, 'preserves external attribution and own JSON metadata without a producer installed'). Core consumers that inspect the kind compare only against 'user' or 'runtime-context' (session-title, session-turn-outline, agent-loop) and fall through for unknown kinds, so the message is retained and its text content reaches the model unchanged; no reader refuses, truncates or reinterprets it. Only WorkstreamService reads the kind, to reconcile its own delivery receipts against a recipient Session (reconcileMessage in packages/experimental/workstream/src/index.ts); it adds no validation, replay or authority requirement for other readers. Current readers: logs written before this change never contain the kind, so reconciliation finds no match and behavior is unchanged. Workstream state: workstream/state is a new ordinary event type with data.version 1 and a complete snapshot, appended by WorkstreamService (index.ts, commit) and decoded strictly by workstreamProjectionDefinition, which requires contiguous revisions and a constant creation operation id. Sessions that never create a Workstream contain no such event. A harness that does not know the type refuses the log before adopting any event, because it is absent from KNOWN_SESSION_EVENT_TYPES and not marked ignorable (packages/session/session-persistence/src/storage-contract.ts, validateStoredEvents raising SessionFormatUnsupportedError, not corruption recovery or tail truncation). The Session format version stays unchanged.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/ticket/tests packages/experimental/workstream/tests packages/session/session-persistence/tests/storage-contract.spec.ts packages/session/session-persistence-jsonl/tests/native-source-admission.spec.ts packages/session/session-format-v3-to-v4/tests/message-sources.spec.ts: 8 files and 95 tests passed. They cover Ticket version 1 history, durable Workstream delivery with reconciliation by the new source kind, unknown-event-type refusal, and unknown source-kind preservation and admission.

<a id="dev-note"></a>
## Dev Note

None.
