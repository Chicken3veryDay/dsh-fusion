---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-08-openai-account-omits

English | [中文](2026-11-08-openai-account-omits.zh.md)

## Summary

Adds account-omits to the persisted unsupportedControl reason union for pre-admission OpenAI Responses refusals.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-08-openai-account-omits
baseline: false
changes:
  - root: "event:assistant/attempt"
    previous: "2026-11-08-llm-unsupported-control"
    after: "26e5aaf509bd226d8197e7d3824a4d5edb0c1555b508b62f418835f037c43963"
    decision: same-version
  - root: "event:assistant/message"
    previous: "2026-11-08-llm-unsupported-control"
    after: "67b40f5b2a6001da68f91a0a12f69b37e8583a20bd2697d5f0ca20f2431c189e"
    decision: same-version
  - root: "event:llm/retry"
    previous: "2026-11-08-llm-unsupported-control"
    after: "89c3dddc900b35125504876c4e130ee078f46d8463b49eced6027a2d8fbee7a7"
    decision: same-version
  - root: "event:turn/end"
    previous: "2026-11-08-llm-unsupported-control"
    after: "aefdcfa65f9adf578ac2708c241ecbbc2f4f0fa1cd31d2a48a7f73f3f43bd83b"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The structural classifier reports union-variants-changed requiring compatibility review on assistant/attempt, assistant/message, llm/retry and turn/end. Existing reasons and records remain valid. The unchanged stored-event reader accepts the known error event and preserves its failure data; no consumer interprets an unknown reason as successful execution or support. The published-base failure normalizer maps the new reason to UNKNOWN while retaining the error message; the current reader preserves account-omits. Error outcomes stay errors in both directions. Writer version and committed generations are unchanged.

<a id="verification"></a>
## Verification

Source probe .artifacts/account-reader-evidence.ts executed the published-base normalizer and unchanged validateStoredEvents against the new account-control-refusal recording: old normalization UNKNOWN, current UNSUPPORTED_CONTROL/account-omits, storage accepts the error event. pnpm run test:snapshot snapshots/sdk/sdk.snapshot.ts -t account-control-refusal: 1 passed. Owning adapter-failure regression retains the new reason and rejects unknown reasons.

<a id="dev-note"></a>
## Dev Note

None.
