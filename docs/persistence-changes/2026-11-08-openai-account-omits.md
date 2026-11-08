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

The repository test packages/llm/llm/tests/adapter-failure.spec.ts compares the frozen pre-account-omits normalizer fixture with the current normalizer: account-omits remains an error (old UNKNOWN, current UNSUPPORTED_CONTROL), older and unknown reasons keep their existing outcomes. The same test restores physical event sequence/time fields from the committed account-control-refusal recording, then runs scanLog and validateStoredEvents and asserts its error turn/end. Run pnpm exec vitest run packages/llm/llm/tests/adapter-failure.spec.ts.

<a id="dev-note"></a>
## Dev Note

None.
