---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-06-context-map-state

English | [中文](2026-11-06-context-map-state.zh.md)

## Summary

Adds the experimental context-map package. It appends the new session event type `context-map/state`, one record per project-map edit carrying the operation, the acting agent, and the whole map snapshot with a contiguous revision.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-06-context-map-state
baseline: false
changes:
  - root: "event:context-map/state"
    previous: null
    after: "ba50066aeeb804e1c799343f712eda4d03aeeace69a606cffcc967ac9f0c8784"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The Session format version is unchanged. A log without `context-map/state` records reads exactly as before. A log that contains one is refused by a build that predates the type, because that build does not list it as a known event type; this follows the existing unknown-event refusal.

<a id="verification"></a>
## Verification

Context map unit tests cover revision conflicts, replay of a contiguous log, and rejection of a gap; a real dsh process test shows the main Session logs the map edits without the curator conversation.

<a id="dev-note"></a>
## Dev Note

None.
