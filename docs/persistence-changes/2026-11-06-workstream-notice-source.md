---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-06-workstream-notice-source

English | [中文](2026-11-06-workstream-notice-source.zh.md)

## Summary

Adds the attribution-only workstream-notice user message source kind.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-06-workstream-notice-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-06-context-core-budget"
    after: "899471c1cea93e0482c1d431f82b7bf437123d56497de8a8422c921032611b33"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-06-context-core-budget"
    after: "38938bc75f551d98c27e05556e8613e48abaf06e366324d8e60c57030fd9b4d0"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-06-context-core-budget"
    after: "a10a18da0b44b8830b2726fc2f53485da7afe1d4907ec38be9ba6bb4dc3c08ee"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-06-context-core-budget"
    after: "e31d8f3851950677d571014bb101f60d4f443e5f1fffe333f8f30ba8d3f0139c"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Only a new attribution kind is added. Workstream writes it for the coordinator-handoff notice delivered to a resumed member and for the notice injected into a resumed Workstream owner that names members whose last turn did not finish. No reader replays, validates, or authorizes from it; readers without the Workstream package preserve the recorded message text. Existing logs contain no such kind.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/workstream/tests packages/experimental/workstream-profile/tests/review-opus-autonomy-e2e-interrupted.spec.ts packages/experimental/workstream-profile/tests/review-opus-autonomy-e2e-handoff.spec.ts: 13 files, 65 tests passed, 2 skipped.

<a id="dev-note"></a>
## Dev Note

None.
