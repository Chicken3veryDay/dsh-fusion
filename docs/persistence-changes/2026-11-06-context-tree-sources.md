---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-06-context-tree-sources

English | [中文](2026-11-06-context-tree-sources.zh.md)

## Summary

Adds the producer-owned context-grant, context-activation, and context-tree-catalog message sources used by the experimental context tree.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-06-context-tree-sources
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-04-ticket-v2-workstream"
    after: "a0cfbdcb8f8cdf3d80caa667cd66be76343cd4f0a2c916e1e2f667907883ed33"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-04-ticket-v2-workstream"
    after: "e86bd65fe9cc12b99cab4ee6a706ec1daf0f892e896caf7c388c505c527b4206"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-04-ticket-v2-workstream"
    after: "0d0ba6281597452b206f8cb5ee78dcfca7a1b848f0850039617e719023520bf5"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-04-ticket-v2-workstream"
    after: "62e46ac5541aefa663e611bc7a30967ba1c3cafb8949371f33e8cf6e87dffafc"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid and no existing discriminator or Session header version changes. Each new source rides on an ordinary user message whose content blocks are plain text, so the message keeps its meaning for any reader that ignores source metadata; only the producing plugin interprets the source fields. Writers add the kinds only when the opt-in context tree is mounted. The context tree rebuilds its state from these messages through a Session projection and ignores a source whose fields it cannot read. No older-reader execution was run for this record.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/context-tree/tests packages/experimental/context-profile/tests: replay determinism, unreadable-source tolerance, and a real dsh process run that persists and replays all three source kinds pass.

<a id="dev-note"></a>
## Dev Note

None.
