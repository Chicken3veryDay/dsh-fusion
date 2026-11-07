---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-06-context-grant-supersedes

English | [中文](2026-11-06-context-grant-supersedes.zh.md)

## Summary

Adds the optional supersedes digest to context-grant message sources.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-06-context-grant-supersedes
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-06-workstream-notice-source"
    after: "966cf861719ca1968084da9040b9041e40f31074a43e62204ffb350faf5d9182"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-06-workstream-notice-source"
    after: "f698aa864cdbe7f2cc2d7db08bbfe49c0ffd1df0d8843d365316e74c93d8460a"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-06-workstream-notice-source"
    after: "41e02cf17c8d3c7ead8e5d25a78bde996d098e14f301b1da844b7f0aca387ad0"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-06-workstream-notice-source"
    after: "1ca9cdbf4d168e4d0876499a7c6de2de9d2604bddea043e37ffe5d3b654a2ab3"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records stay valid: the field is optional and absent in every earlier grant. Older readers ignore it, because the context tree projection parses grant sources without strict field checks and the message text already carries the same notice for the model. Newer readers treat a missing field as a first grant.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/context-tree packages/experimental/context-map packages/experimental/context-profile packages/experimental/context-index: 28 files, 284 tests passed (sweep-fixes.spec.ts asserts supersedes on regranted sections).

<a id="dev-note"></a>
## Dev Note

None.
