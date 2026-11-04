---
description: "Durable Ticket lifecycle, direct worker assignments, reports, questions, attention, and coordinator handoff."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-ticket

English | [中文](README.zh.md)

## Summary

Ticket is the durable coordination record for one piece of work shared by a soft coordinator and direct workers. The Host service stores complete Ticket snapshots in the Session event log and rebuilds them synchronously through `ctx.sessionProjections`. Assignments, execution-slot declarations, work scopes, reports, questions, attention items, coordinator handoff, compare-and-set revisions, and terminal outcomes belong to this domain.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount `@deepseek-ai/dsh-experimental-ticket` beside durable Session storage and `@deepseek-ai/dsh-session-projection`. The package registers `ctx.tickets` and the `ticket` Session projection. It accepts a Session as the durable authority and never creates a second database.

The service exposes `create`, `assign`, `claim`, `release`, `report`, `ask`, `answer`, `closeQuestion`, `attention`, `acknowledgeAttention`, `resolveAttention`, `block`, `handoff`, `complete`, `fail`, and `cancel`. Mutating commands carry `expectedRevision`; a stale value returns `TICKET_STALE_REVISION` and leaves the newer state untouched. Workers are direct Session identities supplied by the execution adapter. The current coordinator answers open questions and acknowledges or resolves attention; question authors may also close their own open or answered questions. Acknowledgement retains the blocker. Worker progress, claims, and release preserve unresolved questions and attention; resolving the last blocker recomputes readiness from assignments. Finished or released assignments reject reports.

Mount `TicketTools` when model callers should coordinate through `ticket_*` commands. Mount `TicketExecutionService` with Jobs and Worktree providers when an assignment needs a shared workspace, an isolated worktree, or owned background jobs. The execution adapter claims the durable Assignment, checks the direct worker identity, starts jobs under that worker Session, and releases live assignments during cleanup.

The [Session projection](../../session/session-projection/README.md) is the browser-safe read path. Every `ticket/state` event carries the complete post-change value, so opening a Session or replaying its events produces the same state and rejects malformed or out-of-order revisions. Command admission and replay share semantic validation; invalid commands append nothing. A proposed Ticket cannot complete directly. Persistence flush failures may occur after append and require reading the current revision before retrying.

Work scopes normalize slash-separated relative paths, collapse `.` and `..`, and reject workspace escapes, absolute paths, drive prefixes, and backslashes. An assignment scope must stay within a declared Ticket scope without escalating read access to write access; a Ticket with no declared scopes leaves assignment declarations unrestricted. Scope declarations and `exclusive` coordinate worker ownership; they do not confine filesystem access or enforce exclusion through a lock.

## Understand the implementation

The package has three small layers:

- [`src/types.ts`](src/types.ts) owns branded ids, JSON-compatible snapshots, requests, browser projection types, and the durable event declaration.
- [`src/projection.ts`](src/projection.ts) validates and folds `ticket/state` events synchronously. It rejects revision gaps, immutable identity changes, duplicate nested ids, and illegal lifecycle transitions.
- [`src/index.ts`](src/index.ts) serializes commands per Session, enforces authority and bounds, appends whole snapshots, checkpoints through `ctx.sessions`, and exposes the `ctx.tickets` service seam.

The service is deliberately independent of Fusion, Agent Teams, Worktree, Jobs, UI, polling, and generic subagent spawning. Those packages can become adapters later while Ticket remains the durable owner of assignment and handoff semantics.

<a id="model-experience"></a>
## Model Experience

### Host coordination and optional tools

#### What the model sees

The core service and `ticket/state` event stay outside model context. `TicketTools` is opt-in and registers direct-worker commands that return JSON Ticket views; it does not create workers or bypass the CAS revision check. Creation is restricted to the caller’s Session and coordinator identity; use handoff to transfer coordination. Cross-Session reads expose only Tickets where the caller coordinates or owns an assignment. There is no automatic event trigger.

#### Token effect

Ticket events are log-only and add no model tokens by themselves.

#### KV Cache effect

Ticket state changes do not alter request headers or model prompt prefixes.

## Known Limitations and Deferred Work

- The execution adapter owns Jobs and Worktree lifetimes in memory; the Ticket log retains the assignment and slot state, while provider-specific job and checkout recovery remains provider-owned.
- The package has no source admission policy or browser supervision UI. Consumers decide which Ticket commands and execution modes require human approval.
- Ticket snapshots are bounded by deployment config, but the first version does not compact old reports, questions, or attention history.
- A Ticket is rooted in one Session log. Cross-Session replication and source-specific ingress remain adapter responsibilities.

<a id="dev-note"></a>
### Dev Note

This package is experimental and has no stability promise. Session events are the authority; projection checkpoints are only replay shortcuts.
