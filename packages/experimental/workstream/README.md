---
description: "Durable Workstream membership, coordinator handoff, acknowledged peer messaging, and root-owned Ticket operations."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-workstream

English | [中文](README.zh.md)

## Summary

Workstream is the durable team record for one root Session. It stores complete Workstream snapshots in the root Session event log and rebuilds them through `ctx.sessionProjections`. Members are continuable direct children of the root. The root keeps technical ownership while coordinator authority can move between members. Peer messages carry distinct accepted and processed receipts. Ticket creation, assignment, and completion run through `ctx.tickets` under the root Session.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount `@deepseek-ai/dsh-experimental-workstream` beside `@deepseek-ai/dsh-experimental-ticket`, Subagent with a continuable provider, durable Session storage, and `@deepseek-ai/dsh-session-projection`. The package registers `ctx.workstreams` and the `workstream` Session projection. Every method takes the exact live calling `Agent`; a stale or replaced `Agent` object is rejected with `WORKSTREAM_UNAUTHORIZED`.

The service exposes `open`, `get`, `list`, `requireMembership`, `addMember`, `handoff`, `sendMessage`, `acknowledge`, `waitForChange`, `interrupt`, `stop`, `createTicket`, `assignTicket`, and `endTicket`. Only a root Session can call `open`. A root owns at most one Workstream, and `open` is idempotent for the same `operationId` and title. The owner is the first member with role `owner` and is also the first coordinator. `addMember` provisions a continuable child through the named Subagent provider, which must implement `prepareContinuable`. `handoff` transfers coordinator authority to an active member and takes `expectedRevision`; a changed revision returns `WORKSTREAM_CONFLICT`. Children keep the root as their parent after a handoff. Coordinator operations (`addMember`, `handoff`, `interrupt`, `stop`, `assignTicket`, `endTicket`) require the immutable owner or the current coordinator. `stop` rejects the owner and the current coordinator, so the coordinator hands off before stopping itself.

Every mutating operation takes a caller-chosen `operationId`. Reusing an id with different input returns `WORKSTREAM_CONFLICT`. Provisioning a member and delivering a message are not repeated after an uncertain outcome: the service returns `WORKSTREAM_UNKNOWN`, and a retry with the same id reads the child Session log to confirm acceptance before it records progress. A message moves through `intent`, `accepted` (the recipient's inbox took it), and `processed` (the recipient called `acknowledge`). An idle recipient does not imply `processed`. `sendMessage` accepts an optional `WorkstreamContextPacket`, which is logged with the message and delivered to the recipient.

`waitForChange` resolves when the root Session appends any event, including Ticket events, when `timeoutMs` elapses, or rejects on caller abort or service shutdown. `timeoutMs` must be a positive integer no greater than `maxWaitMs`. If the Workstream revision already differs from `afterRevision`, it returns at once.

`createTicket`, `assignTicket`, and `endTicket` forward to `ctx.tickets` on the root Session with the owner as Ticket actor. Any active member can propose a Ticket. Assignment requires an active child member, and completion applies the Ticket acceptance checks.

Mount `WorkstreamTools` when model callers should use the service. Mounting the tools is optional and independent of the service. Config fields, all positive safe integers: `maxMembers` (16), `maxMessages` (256), `maxSnapshotBytes` (1048576), `maxMessageBytes` (65536), and `maxWaitMs` (3600000). Exceeding a bound returns `WORKSTREAM_LIMIT`.

Errors are `WorkstreamError` values with code `WORKSTREAM_UNAUTHORIZED`, `WORKSTREAM_NOT_FOUND`, `WORKSTREAM_CONFLICT`, `WORKSTREAM_LIMIT`, `WORKSTREAM_INVALID_INPUT`, `WORKSTREAM_UNKNOWN`, or `WORKSTREAM_DISPOSED`. `WORKSTREAM_UNKNOWN` means the effect may have happened; inspect the durable record before acting again.

The [Session projection](../../session/session-projection/README.md) key `workstream` is the browser-safe read path and holds `null` for Sessions that own no Workstream. Import `@deepseek-ai/dsh-experimental-workstream/client` for browser-safe types and `@deepseek-ai/dsh-experimental-workstream/types` for types.

## Understand the implementation

The package has four small layers:

- [`src/types.ts`](src/types.ts) owns the snapshot, member, message, context packet, request, and config types, plus the `workstream/state` event, the `workstream` projection, and the `workstream-message` message source declarations.
- [`src/projection.ts`](src/projection.ts) validates each `workstream/state` event against a strict schema, ignores events whose `ownerSessionId` differs from the Session being folded, and rejects revision gaps and changes to the creation `operationId`.
- [`src/index.ts`](src/index.ts) serializes operations per root Session, enforces authority and bounds, appends whole snapshots with `version: 1`, flushes through `ctx.sessions`, and exposes `ctx.workstreams`.
- [`src/tools.ts`](src/tools.ts) registers the opt-in `workstream_*` tools through `ctx.tools`.

The root Session is the only technical owner and the only writer of `workstream/state`. Message acceptance is confirmed from the recipient's Session log by the `workstream-message` source, which carries the root id, operation id, and sender id, so a retry never sends a second copy. Shutdown aborts waits, awaits pending operations, and drains the member children.

<a id="model-experience"></a>
## Model Experience

### Opt-in Workstream tools

#### What the model sees

`WorkstreamTools` registers 13 tools: `workstream_open`, `workstream_get`, `workstream_list`, `workstream_add_member`, `workstream_send`, `workstream_acknowledge`, `workstream_handoff`, `workstream_wait`, `workstream_interrupt`, `workstream_stop`, `workstream_create_ticket`, `workstream_assign_ticket`, and `workstream_end_ticket`. Most take `root_session_id` and, for mutations that can be retried, `operation_id`. Results are the JSON value of the service result, rendered as one text block. `workstream_interrupt` returns `{ "interrupted": true }`. `workstream_send` has no parameter for a context packet. The tools are not in the generated tool catalog because no shipped profile registers them.

#### Token effect

Tool definitions add schema tokens for each registered tool while `WorkstreamTools` is mounted. Each call returns the whole affected value as JSON: `workstream_get` returns every member and message receipt, so its size grows with `maxMembers` and `maxMessages`.

#### KV Cache effect

Registering or removing the tools changes the tool list, which can replace the cached request prefix for Sessions that expose it. Tool results are append-only growth after they are produced.

### Peer messages and member prompts

#### What the model sees

A recipient sees one user message whose content is a JSON text block `{"sender":<Session id>,"text":<message text>,"context":<packet or null>}`, with message source kind `workstream-message`. The owner receives it as a steered message, and a child receives it through its Subagent inbox. A new member sees the `prompt` passed to `workstream_add_member` as its first prompt. The text is supplied by callers at runtime and is not package-owned.

#### Token effect

Each message adds its serialized size to the recipient's context, bounded by `maxMessageBytes` for the complete stored message. A member prompt is stored in the snapshot, so `maxSnapshotBytes` bounds it.

#### KV Cache effect

Both entries append to the recipient's own conversation and do not change the sender's request prefix.

## Known Limitations and Deferred Work

- A Workstream is rooted in one live root Session. Operations on another Session's Workstream need that root `Agent` live, and cross-root Workstreams are not modeled. `list` returns at most the caller's own root Workstream.
- Members are direct continuable children of the root. Nested children cannot join, and a stopped member keeps its name reserved.
- The package has no browser supervision UI and no automatic trigger for a received message; recipients learn of messages through their inbox and may call `workstream_wait`.
- `workstream_send` cannot attach a context packet. Callers that need one use the service method directly.
- Snapshots keep every member and message receipt and are not compacted; bounds apply to the complete snapshot, so a long-lived Workstream reaches `WORKSTREAM_LIMIT`.
- Ticket operations run with the root owner as Ticket actor and coordinator, so handing off the Workstream coordinator does not change the coordinator recorded in Tickets already created.
- An uncertain provisioning or delivery returns `WORKSTREAM_UNKNOWN`. The service reconciles only when the caller retries the same operation; it never relaunches a child or resends a message by itself.

<a id="dev-note"></a>
### Dev Note

This package is experimental and has no stability promise. Session events are the authority; projection checkpoints are only replay shortcuts.
