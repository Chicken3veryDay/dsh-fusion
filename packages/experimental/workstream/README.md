---
description: "Durable Workstream membership, coordinator handoff, acknowledged peer messaging, and root-owned Ticket operations."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-workstream

English | [中文](README.zh.md)

## Summary

Workstream is the durable team record for one root Session. It stores complete Workstream snapshots in the root Session event log and rebuilds them through `ctx.sessionProjections`. Members are continuable direct children of the root. The root keeps technical ownership while coordinator authority can move between members. Peer messages carry distinct accepted and processed receipts. Ticket creation, assignment, and completion run through `ctx.tickets` under the root Session, and Ticket coordination follows the Workstream coordinator.

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

The service exposes `open`, `get`, `list`, `requireMembership`, `addMember`, `handoff`, `sendMessage`, `acknowledge`, `cursor`, `waitForChange`, `interrupt`, `stop`, `createTicket`, `assignTicket`, and `endTicket`. Only a root Session can call `open`. A root owns at most one Workstream, and `open` is idempotent for the same `operationId` and title. The owner is the first member with role `owner` and is also the first coordinator. `addMember` provisions a continuable child through the named Subagent provider, which must implement `prepareContinuable`. `handoff` transfers coordinator authority to an active member and takes `expectedRevision`; a changed revision returns `WORKSTREAM_CONFLICT`. Children keep the root as their parent after a handoff. Coordinator operations (`addMember`, `handoff`, `interrupt`, `stop`) require the immutable owner or the current coordinator. `assignTicket` and `endTicket` require the sitting coordinator itself, because the Ticket records the caller as actor; the owner reclaims the role with `handoff` first. `stop` rejects the owner and the current coordinator, so the coordinator hands off before stopping itself. `stop` commits the `stopping` phase under the root queue, releases the queue while the child drains so its own queued Workstream tool calls can finish, and then commits `stopped` from current state. `addMember` and `sendMessage` follow the same rule, because no operation may wait for a member while it holds the queue that the member's own Workstream tools need: they commit their intent under the queue; a launch that cannot be confirmed is drained, and a message is delivered, with the queue released; and `sendMessage` commits the receipt under the queue again. A retry of a message whose delivery is still running joins that delivery. `stop` waits for deliveries to its target before it drains, so a delivery cannot resume the member afterwards.

`open`, `addMember`, and `sendMessage` take a caller-chosen `operationId`, and `acknowledge` names the `operationId` of the message it acknowledges. `handoff` is guarded by `expectedRevision`, `stop` and `interrupt` act on the member's current phase and take no operation id, and the Ticket operations are guarded by the Ticket revision. Reusing an operation id with different input returns `WORKSTREAM_CONFLICT`. Provisioning a member and delivering a message are not repeated after an uncertain outcome: the service returns `WORKSTREAM_UNKNOWN`, and a retry with the same id reads the child Session log to confirm acceptance before it records progress. A message moves through `intent`, `accepted` (the recipient's inbox took it), and `processed` (the recipient called `acknowledge`). An idle recipient does not imply `processed`. `sendMessage` accepts an optional `WorkstreamContextPacket`, which is logged with the message and delivered to the recipient. A retry that finds its earlier result already recorded (an open Workstream, an active member, an accepted or processed message even after its recipient stopped, a stopped member) flushes the root Session before it returns, so a first attempt whose write failed after the append cannot be reported as committed; a continuing storage failure rejects the retry.

When a Workstream owner is resumed, the service reads the Session log of each active child member that has no registered Agent. A member whose last turn is still open, or ended `aborted` or `interrupted`, did not finish: a shutdown or reload drained it, and nothing resumes it. Its membership stays `active` and its Ticket assignment can still read `running`. The service injects one `workstream-notice` message into the owner, listing each such member's name, Session id and turn number, and naming `workstream_send` to continue it and `workstream_stop` to stop it. A member whose log cannot be read is listed as `log unreadable`, and the owner resume proceeds. The injection does not wake the owner; its next request carries the notice. The notice is written again at each owner resume while a member's last turn stays unfinished.

`cursor` returns the caller's wait cursor: the root Session position after the last committed event. `waitForChange` takes `afterRevision`, an optional `afterCursor`, `timeoutMs`, and a caller signal, and returns `{ timedOut, revision, cursor }` with the current Workstream revision and cursor. It returns at once when the revision differs from `afterRevision`, or when a concerning event was committed at or after the cursor; without `afterCursor`, the cursor is the position after the event that committed `afterRevision`. Otherwise it resolves at the next concerning event or when `timeoutMs` elapses, and rejects on caller abort or service shutdown, also when a change is already visible. Concerning events are Workstream changes and root Ticket changes: every Ticket for the owner and the sitting coordinator, and for another member only Tickets that name it as coordinator or Assignment owner, including its own changes. Other root events, such as the owner's turns, never end the wait. `timeoutMs` must be a positive integer no greater than `maxWaitMs`; `afterCursor` must be a non-negative integer no greater than the current cursor, otherwise `WORKSTREAM_INVALID_INPUT`. Pass the returned revision and cursor to the next wait, so each concerning change is reported once; a wait given only a revision keeps reporting the Ticket changes committed after that revision.

`createTicket`, `assignTicket`, and `endTicket` forward to `ctx.tickets` on the root Session. `createTicket` records the current Workstream coordinator as the Ticket coordinator, and `assignTicket` and `endTicket` pass the authenticated caller as Ticket `actorId`, so Ticket history shows who coordinated. Any active member can propose a Ticket. Assignment requires an active child member. Workstream also registers a Ticket assignment authority, so a direct `ctx.tickets.assign` for a root with a Workstream is refused with `TICKET_AUTHORITY` unless the assignee is an active child member when the assignment commits, even if a stop completed while the assignment waited in Ticket's queue; a root with no Workstream is not governed, and the authority returns the retryable `TICKET_COORDINATOR_UNAVAILABLE` while Workstream is still loading. Workstream also registers a Ticket command authority: in a root with a Workstream, every Ticket command must be made by the owner or by an active direct-child member at the moment it commits, so a command from a member that `stop` revoked while the command waited in Ticket's queue, or from a live Agent that is not a member, fails with `TICKET_AUTHORITY` and a `WORKSTREAM_UNAUTHORIZED` cause, and nothing is appended. Owner commands, including the owner-initiated Ticket handoffs of `handoff`, and Ticket's own settlement and recovery writes are not refused; other actors get the retryable `TICKET_COORDINATOR_UNAVAILABLE` while Workstream is still loading. Completion applies the Ticket acceptance checks. Passing another Session id is never authorization: Ticket authority is the sitting coordinator, checked against the live `Agent`.

`handoff` moves Ticket coordination with the role. It first hands every open root Ticket coordinated by a Workstream member to the new coordinator through `ctx.tickets.handoff`, then commits the Workstream snapshot. The final snapshot size is checked before any Ticket moves, and the open Tickets are listed again until none remain, so Tickets created through `ctx.tickets` during the handoff also move. The last empty list and the snapshot append run in one synchronous step, so no Ticket appears between them; a direct `ctx.tickets.create` that defaults to the owner afterwards names the sitting coordinator through the Ticket coordinator authority that Workstream registers. The authority is installed before the projection registration finishes and refuses an owner-default `create` with Ticket's retryable `TICKET_COORDINATOR_UNAVAILABLE`, whose message says to retry and whose cause is `WORKSTREAM_NOT_READY` (nothing appended), until recovered snapshots are readable, so a Ticket created during a reload cannot record the owner and never be reconciled; retry after the Workstream has loaded. An explicit non-owner coordinator is unaffected. The snapshot is the commit point, so the Workstream coordinator never names a member the Tickets have not followed. Each Ticket moves at most once per call: a Ticket handed back by a competing writer, or any move after service shutdown begins, ends the call with `WorkstreamPartialHandoffError` (a stopped service with no Ticket moved throws `WORKSTREAM_DISPOSED`) instead of re-listing indefinitely. The target must be a registered live Agent, as `ctx.tickets.handoff` requires, because durable `active` membership survives a drained or unloaded child. `handoff` checks this before any Ticket moves and again in the same synchronous step as the snapshot append; with no Ticket moved it throws `WORKSTREAM_INVALID_INPUT`, and if the target disappears after Tickets moved it throws `WorkstreamPartialHandoffError` with the moved ids and the coordinator unchanged, so a handoff back to a live member recovers. An active child member with no registered Agent, because it finished its turn or the process restarted, is first cold-resumed through Subagent with a `workstream-notice` message that tells it the role is being handed to it; the notice starts its turn. The resume runs inside the root queue: a member without a registered Agent has no running driver, so none of its Workstream tool calls can be waiting on that queue, and the Workstream calls it makes after the resume run after the commit. Its Ticket reads do not use the queue, so a read made before the commit still names the previous coordinator. A resume that fails throws `WORKSTREAM_INVALID_INPUT` with nothing committed and names `workstream_send` as the way to start the member before retrying. A member that already has a registered Agent receives no notice. Ticket's own handoff must be authorized by the Ticket's current coordinator, so Workstream passes the owner as the handing-off actor, which Ticket accepts without the Ticket's coordinator authority. Ticket records no handoff actor. If any Ticket cannot move, `handoff` throws `WorkstreamPartialHandoffError` (code `WORKSTREAM_PARTIAL_HANDOFF`) with `moved` and `pending` Ticket ids and leaves the Workstream coordinator unchanged. Repeat the same call to move the remaining Tickets; Tickets already at the target are skipped. Moving a `proposed` Ticket sets it to `coordinating`, as Ticket handoff does.

Unloading the service first refuses new Workstream calls and withdraws its Ticket authorities, so Ticket commands admitted afterwards are no longer governed. It then awaits its own queued operations and `ctx.tickets.whenIdle` for every root with a Workstream before it drains the members. Ticket decides each command admitted earlier with the authorities registered at its admission, so a Ticket command already queued when the unload begins still commits or fails under Workstream's rules.

Mount `WorkstreamTools` when model callers should use the service. Mounting the tools is optional and independent of the service. Config fields, all positive safe integers: `maxMembers` (16), `maxMessages` (256), `maxSnapshotBytes` (1048576), `maxMessageBytes` (65536), and `maxWaitMs` (3600000). Exceeding a bound returns `WORKSTREAM_LIMIT`.

Errors are `WorkstreamError` values with code `WORKSTREAM_UNAUTHORIZED`, `WORKSTREAM_NOT_FOUND`, `WORKSTREAM_CONFLICT`, `WORKSTREAM_LIMIT`, `WORKSTREAM_INVALID_INPUT`, `WORKSTREAM_UNKNOWN`, `WORKSTREAM_DISPOSED`, `WORKSTREAM_PARTIAL_HANDOFF`, `WORKSTREAM_NOT_READY`, or `WORKSTREAM_CAPACITY`. `WORKSTREAM_UNKNOWN` means the effect may have happened; inspect the durable record before acting again. `WORKSTREAM_CAPACITY` means Subagent refused the member at its per-root activation limit (`maxActiveSubagents`) before any child existed: `addMember` removes the `provisioning` record it committed, so no member, name, or operation id stays reserved, and the error names the limit. A member whose turn ends or that is stopped frees a slot; the same operation then provisions the member, or returns `WORKSTREAM_CAPACITY` again while the pool is still full.

The [Session projection](../../session/session-projection/README.md) key `workstream` is the browser-safe read path and holds `null` for Sessions that own no Workstream. Import `@deepseek-ai/dsh-experimental-workstream/client` for browser-safe types and `@deepseek-ai/dsh-experimental-workstream/types` for types.

## Understand the implementation

The package has four small layers:

- [`src/types.ts`](src/types.ts) owns the snapshot, member, message, context packet, request, and config types, plus the `workstream/state` event, the `workstream` projection, and the `workstream-message` and `workstream-notice` message source declarations.
- [`src/projection.ts`](src/projection.ts) validates each `workstream/state` event against a strict schema, ignores events whose `ownerSessionId` differs from the Session being folded, and rejects revision gaps and changes to the creation `operationId`. It also records the position of the snapshot's event, of the latest root `ticket/state` event after the Workstream opened, and of the latest such event per coordinator or Assignment owner, which `waitForChange` compares with the cursor. Participant positions are stored as `[Session id, seq]` pairs, so every admitted Session id, including `__proto__`, keeps its position. A checkpoint is accepted only in a state that full replay can produce: an opened snapshot always carries the position of its committing event, each participant has one position, and the recorded Ticket positions agree with each other. The projection registry discards a checkpoint row that fails this validation or carries another `stateVersion`, and refolds the Workstream from the complete log instead of restoring a missing position; the cached listing omits such a row.
- [`src/index.ts`](src/index.ts) serializes operations per root Session, enforces authority and bounds, appends whole snapshots with `version: 1`, flushes through `ctx.sessions`, and exposes `ctx.workstreams`.
- [`src/tools.ts`](src/tools.ts) registers the opt-in `workstream_*` tools through `ctx.tools`.

The root Session is the only technical owner and the only writer of `workstream/state`. Message acceptance is confirmed from the recipient's Session log by the `workstream-message` source, which carries the root id, operation id, and sender id, so a retry never sends a second copy. Shutdown aborts waits, awaits pending operations, and drains the member children.

<a id="model-experience"></a>
## Model Experience

### Opt-in Workstream tools

#### What the model sees

`WorkstreamTools` registers 13 tools: `workstream_open`, `workstream_get`, `workstream_list`, `workstream_add_member`, `workstream_send`, `workstream_acknowledge`, `workstream_handoff`, `workstream_wait`, `workstream_interrupt`, `workstream_stop`, `workstream_create_ticket`, `workstream_assign_ticket`, and `workstream_end_ticket`. Most take `root_session_id` and, for mutations that can be retried, `operation_id`. Results are the JSON value of the service result, rendered as one text block. `workstream_get` adds `cursor` to the snapshot, and `workstream_wait` takes `after_revision`, optional `after_cursor`, and `timeout_ms` and returns `{ "timedOut": <boolean>, "revision": <number>, "cursor": <number> }`. `workstream_interrupt` returns `{ "interrupted": true }`. `workstream_create_ticket` takes an optional `ticket_id`; a duplicate id is rejected. `workstream_send` takes an optional `context` packet with `requirements`, `decisions`, `cursor`, `changes`, and `artifacts` (`ref` and `digest`); every field is required inside the packet, extra fields are rejected, and an over-large complete message returns `WORKSTREAM_LIMIT` before anything is logged. The tools are not in the generated tool catalog because no shipped profile registers them.

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

### Workstream notices

#### What the model sees

A member that `workstream_handoff` resumes sees one user message with source kind `workstream-notice`: "The coordinator role of Workstream <root id> is being handed to you. When workstream_get shows your Session id as coordinatorId, you coordinate its Tickets: create, assign and end them, and hand the role back when done." A resumed owner with unfinished members sees one injected user message with the same source kind: "These Workstream <root id> members are not running and their last turn did not finish, so their Ticket assignments may still read running: <name> (<Session id>, turn <n>); …. Send each a message with workstream_send to continue its work, or stop it with workstream_stop." A member whose log cannot be read appears as `<name> (<Session id>, log unreadable)`.

#### Token effect

The handoff notice is about 50 tokens. The owner notice is about 50 tokens plus about 20 per listed member, at most `maxMembers` members.

#### KV Cache effect

Both notices append to the recipient's conversation and leave its earlier request prefix unchanged.

## Known Limitations and Deferred Work

- A Workstream is rooted in one live root Session. Operations on another Session's Workstream need that root `Agent` live, and cross-root Workstreams are not modeled. `list` returns at most the caller's own root Workstream, and an empty list for a caller that is not an active member of it, such as a stopped member or an ordinary child of the root.
- Members are direct continuable children of the root. Nested children cannot join, and a stopped member keeps its name reserved.
- The package itself has no UI (the [Web panel](../client-ui-workstream/README.md) shows it) and no automatic trigger for a received message; recipients learn of messages through their inbox and may call `workstream_wait`.
- The context packet is caller-supplied text; Workstream does not assemble requirements, decisions, or changes since the cursor, and does not read artifact bytes or verify digests.
- Snapshots retain stopped members and every message receipt; concurrent retries join an in-flight delivery. Snapshots are not compacted; bounds apply to the complete snapshot, so a long-lived Workstream reaches `WORKSTREAM_LIMIT`.
- Handoff moves every open root Ticket coordinated by a Workstream member, including Tickets created directly through `ctx.tickets`. Ticket history does not record who moved a Ticket. A concurrent Ticket mutation, including a hand-back by the owner, can leave a Ticket pending until `handoff` is retried. A direct Ticket created with an explicit coordinator other than the owner keeps that coordinator until a handoff moves it.
- A member whose turn a shutdown or reload stopped is reported to its resumed owner, not resumed; its membership stays `active` and its Ticket assignment keeps its recorded status until the owner sends it a message or stops it. The report costs one read of each such member's Session log at every owner resume, and repeats at each resume until the member's last turn finishes.
- An uncertain provisioning or delivery returns `WORKSTREAM_UNKNOWN`. The service reconciles only when the caller retries the same operation; it never relaunches a child or resends a message by itself.
- Inside a Node PTC `run_code` program, `workstream_wait` is also bounded by the program's `timeoutMs` (default 120 s, at most 600 s). When the program ends first, the wait is cancelled with it, its change listener is removed, and the program fails with the timeout error. No wake is lost, because `revision` and `cursor` are durable: a later `workstream_wait` with the last pair returns at once for any change committed after it. Keep `timeout_ms` below the program timeout, or wait outside `run_code`.

<a id="dev-note"></a>
### Dev Note

This package is experimental and has no stability promise. Session events are the authority; projection checkpoints are only replay shortcuts.
