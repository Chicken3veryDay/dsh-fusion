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

The service exposes `create`, `assign`, `claim`, `release`, `report`, `ask`, `attention`, `block`, `handoff`, `complete`, `fail`, and `cancel`. Mutating commands carry `expectedRevision`; a stale value returns `TICKET_STALE_REVISION` and leaves the newer state untouched. Workers are direct Session identities supplied by the later execution adapter. Execution slots and work scopes are declarations only in this package.

The [Session projection](../../session/session-projection/README.md) is the browser-safe read path. Every `ticket/state` event carries the complete post-change value, so opening a Session or replaying its events produces the same state and rejects malformed or out-of-order revisions.

## Understand the implementation

The package has three small layers:

- [`src/types.ts`](src/types.ts) owns branded ids, JSON-compatible snapshots, requests, browser projection types, and the durable event declaration.
- [`src/projection.ts`](src/projection.ts) validates and folds `ticket/state` events synchronously. It rejects revision gaps, immutable identity changes, duplicate nested ids, and illegal lifecycle transitions.
- [`src/index.ts`](src/index.ts) serializes commands per Session, enforces authority and bounds, appends whole snapshots, checkpoints through `ctx.sessions`, and exposes the `ctx.tickets` service seam.

The service is deliberately independent of Fusion, Agent Teams, Worktree, Jobs, UI, polling, and generic subagent spawning. Those packages can become adapters later while Ticket remains the durable owner of assignment and handoff semantics.

<a id="model-experience"></a>
## Model Experience

### Host-only coordination state

#### What the model sees

This package registers no model tool, prompt section, or automatic event trigger. The Host-only `ctx.tickets` service and log-only `ticket/state` event stay outside model context. A later adapter may render Ticket views or command results to a model; that adapter owns the model-facing text.

#### Token effect

Ticket events are log-only and add no model tokens by themselves.

#### KV Cache effect

Ticket state changes do not alter request headers or model prompt prefixes.

## Known Limitations and Deferred Work

- Execution slots and work scopes are durable declarations. Worktree creation, process ownership, Jobs output, overlap enforcement, cleanup, and restart adapters are deferred to later packages.
- The package has no model-facing tool surface or browser UI. Consumers decide which Ticket commands require a human approval step.
- Ticket snapshots are bounded by deployment config, but the first version does not compact old reports, questions, or attention history.
- A Ticket is rooted in one Session log. Cross-Session replication and source-specific ingress remain adapter responsibilities.

<a id="dev-note"></a>
### Dev Note

This package is experimental and has no stability promise. Session events are the authority; projection checkpoints are only replay shortcuts.
