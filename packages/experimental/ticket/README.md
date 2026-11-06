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

Mount `@deepseek-ai/dsh-experimental-ticket` beside durable Session storage and `@deepseek-ai/dsh-session-projection`. The package registers `ctx.tickets` and the `ticket` Session projection. The Session owns durable state; every public mutation requires an exact registered Agent under `ctx.agents.withInitiator`, matching `actorId` when supplied. Creation requires the technical owner; that owner may also reclaim coordination through `handoff`. Creation and handoff require a registered live coordinator Agent. Missing, stale, or impersonated callers return `TICKET_AUTHORITY`.

The service exposes `create`, `assign`, `claim`, `release`, `report`, `ask`, `answer`, `closeQuestion`, `attention`, `acknowledgeAttention`, `resolveAttention`, `block`, `handoff`, `complete`, `fail`, and `cancel`. Mutating commands carry `expectedRevision`; a stale value returns `TICKET_STALE_REVISION` and leaves the newer state untouched. Workers are direct Session identities supplied by the execution adapter. The current coordinator answers open questions and acknowledges or resolves attention; question authors may also close their own open or answered questions. Acknowledgement retains the blocker. Worker progress, claims, and release preserve unresolved questions and attention; resolving the last blocker recomputes readiness from assignments. Finished or released assignments reject reports; a successful execution settlement leaves its assignment open for the result report. A specification edit reopens completed contributions without attempt history for a fresh model report, retaining old reports as history. Assignments with attempts require a fresh host-admitted attempt; legacy claim cannot reopen them. Exclusive write assignments require a workspace-bearing attempt instead of a legacy claim. Candidate submissions naming assignments without current result reports return `TICKET_ACCEPTANCE` with the assignment identity. Required children constrain acceptance; unfinished, failed, or cancelled children do not prevent parent cancellation or failure.

Mount `TicketTools` when model callers should coordinate through `ticket_*` commands. Mount `TicketExecutionService` with Jobs and Worktree providers when an assignment needs a shared workspace, an isolated worktree, or owned background jobs. The execution adapter admits the durable attempt, checks the direct worker identity, and receives an attempt-bound recorder that serializes execution facts with all Ticket commands without caller CAS. Preparation must match any current initiating Agent. The recorder survives coordinator handoff and preparing Agent disposal. It preserves runtime identity and appends each job id to its receipt before starting the producer. The `prepare` signal cancels only preparation and is not retained once the handle is published; a `startJob` signal stays attached to its Job until that producer settles or the handle is cleaned up. Failed Jobs dominate cancelled Jobs, and either prevents success. Disposal requests cancellation before durable writes and awaits retained producer promises even after Agent cleanup removes their Job records. A pending or timed-out natural settlement can escalate to disposal. Cancellation or shutdown before any producer starts settles the attempt as cancelled, retaining any known workspace receipt. Uncertain resource creation remains unknown. Automatic owner-disposal callbacks do not retry a failed stop; explicit disposal and teardown may retry it. Once the producer outcome is known, Ticket owns the settlement until it is durable, as [the attempt state machine](#attempt-state-machine) describes; disposal of a handle whose root Session is closed rejects with the retryable `TICKET_SETTLEMENT_PENDING`, and resuming that root writes the settlement. Disposal of the caller, worker or root during any preparation phase, including the admission flush, publishes no handle, ends the attempt as cancelled, and rejects `prepare` with `TICKET_AUTHORITY`. When the admission's own flush fails, an identical `prepare` retry repeats the flush and continues preparation; if no retry comes, that disposal or teardown ends the attempt as cancelled. Repeating a settled preparation returns `TICKET_ATTEMPT_STATE`.

A package that owns coordination for a Session registers with `registerCoordinatorAuthority(authority)`, which returns the disposer. `create` asks each authority inside the Session's command queue, in the same synchronous step that reads the Session state and appends the Ticket. The authority receives the requested coordinator (`CreateTicketRequest.coordinatorId`, or the Session id when absent) and may return a replacement; the first replacement wins, so a Ticket created while coordination moves names the coordinator the authority decided at the append. An authority that throws a `TicketError` fails the creation with that error unchanged, such as a retryable `TICKET_COORDINATOR_UNAVAILABLE` from an authority that is still loading; any other exception returns `TICKET_RECOVERY_FAILED` with the original cause. Neither appends anything. A coordinator that is not a registered live Agent returns `TICKET_AUTHORITY` naming it, whether the authority selected it, and the remedy: resume that Agent, or hand coordination back to the Session owner.

A package that owns who may receive work registers with `registerAssignmentAuthority(authority)`, which returns the disposer. `assign` asks each authority inside the Session's command queue, after the actor, CAS, limit and subject checks and immediately before the append, so the decision reflects the assignee at the moment the assignment commits, not when the call was made. The authority receives the Session and the requested `ownerId` and refuses by throwing a `TicketError`, which fails the assignment unchanged and appends nothing; any other exception returns `TICKET_RECOVERY_FAILED` with the original cause. A Session with no registered authority accepts any assignee.

The [Session projection](../../session/session-projection/README.md) is the browser-safe read path. Every `ticket/state` event carries the complete post-change value, so opening a Session or replaying its events produces the same state and rejects malformed or out-of-order revisions. Legacy v1 reports are projected onto the synthesized initial specification so retained results can enter a v2 candidate without rewriting old events. Command admission and replay share semantic validation; invalid commands append nothing. A proposed Ticket cannot complete directly. Persistence flush failures may occur after append and require reading the current revision before retrying. Idempotent attempt-operation retries flush the Session again before reporting success, including retries of an operation that settlement compacted into its attempt's tombstone. The tombstone keeps each retired operation's fingerprint, so a compacted retry with changed arguments returns `TICKET_OPERATION_CONFLICT`, and reusing such an id for another attempt returns `TICKET_ATTEMPT_STATE`.

Work scopes normalize slash-separated relative paths, collapse `.` and `..`, and reject workspace escapes, absolute paths, drive prefixes, and backslashes. An assignment scope must stay within a declared Ticket scope without escalating read access to write access; a Ticket with no declared scopes leaves assignment declarations unrestricted. Attempt admission atomically excludes overlapping write scopes when either declaration is exclusive in the same shared execution world. Scope checks and append run synchronously; unrelated roots do not wait for another root’s flush. Reservations survive root Session closure and remain held through stopping, unknown status, or failed settlement flushes. Activation reads no stored log. The first shared-workspace admission lists storage and folds only the `ticket/state` events of each stored root that is not live, without resuming producers; later admissions reuse that scan. A listing failure, or a stored root that cannot be read, refuses shared-workspace admission with `TICKET_RECOVERY_FAILED` naming the cause or root, and the next admission retries it. When a root's stored Session no longer exists, its reservations are released unless an owner in this host still awaits its producer's outcome; deleting a log does not settle a producer, so that owner's reservation is released once it hands an outcome to the ledger. A live root that fails replay is reported against that root and retains its known scopes; unrelated scopes remain available. Isolated worktrees and distinct execution worlds remain independent; scopes do not confine filesystem access.

## Understand the implementation

The package has three small layers:

- [`src/types.ts`](src/types.ts) owns branded ids, JSON-compatible snapshots, requests, browser projection types, and the durable event declaration.
- [`src/projection.ts`](src/projection.ts) validates and folds `ticket/state` events synchronously. It rejects revision gaps, immutable identity changes, duplicate nested ids, and illegal lifecycle transitions.
- [`src/index.ts`](src/index.ts) serializes commands per Session, enforces authority and bounds, appends whole snapshots, checkpoints through `ctx.sessions`, and exposes the `ctx.tickets` service seam.

<a id="attempt-state-machine"></a>
### Attempt state machine

Each admitted attempt has exactly one owner at a time, and every write names the root Session by id, resolving it when the write runs.

| State | Owner | Ends when |
|---|---|---|
| `preparing` | `TicketExecutionService` reservation and its preparation lifetime | The admission records a reserved execution-ownership operation with the attempt. The workspace is recorded (`running`). A certain failure or cancellation before any producer hands `failed` or `cancelled`, with any known workspace receipt, to the ledger before any other write. An uncertain worktree or activation records `unknown`. Disposal of the caller, worker or root, or teardown, aborts the lifetime in every phase, publishes no handle and hands `cancelled` to the ledger. If the admission flush fails, an identical retry continues; without one, that disposal or teardown hands `cancelled` to the ledger. |
| `running` | `TicketExecutionService` handle | `settle()`, `dispose()`, owner disposal or teardown observes every producer and hands the outcome to the ledger; a producer that does not settle within `settlementTimeoutMs` records `unknown`. |
| `unknown` | Host reconciliation | A host caller records the observed outcome with `settleAttempt`. |
| Outcome handed to the ledger | `TicketService` settlement ledger | The ledger takes the outcome synchronously and appends the `settled` snapshot to the live root. A closed root returns `TICKET_SETTLEMENT_PENDING`; resuming it replays the write. A failed flush is repeated by the next settlement retry or Ticket write on that root, and teardown makes one last attempt. If the root's stored Session is deleted, the outcome is discarded with it. |
| `settled` | None | Terminal. `failed` and `cancelled` release the assignment; `succeeded` leaves it open for its result report. The scope reservation and ledger entry are released only by the flush that makes the settlement durable, or by deletion of the root's stored Session once the ledger holds the outcome. |

After a restart, a resumed root settles an attempt as `cancelled` when its reserved execution operations show that this host family admitted it, no owner in this host holds it, and it either ran in process and is `preparing`, `running` or `stopping`, or is still `preparing` in any placement, because no producer starts before the workspace stage. Roots live when Ticket activates are left to their earlier owner. Manual attempts, and dedicated-process or remote attempts past their workspace stage, stay reserved until a host caller settles them.

The Ticket service is independent of Fusion, Agent Teams, Worktree, Jobs, UI, polling, and generic subagent spawning. The optional execution adapter composes existing Jobs, Worktree, and Subagent providers while Ticket retains durable assignment and handoff semantics.

<a id="model-experience"></a>
## Model Experience

### Host coordination and optional tools

#### What the model sees

The core service and `ticket/state` event stay outside model context. `TicketTools` is opt-in and registers direct-worker commands that return JSON Ticket views; it does not create workers or bypass the CAS revision check. Specification revision, candidate submission, and criterion checks use `ticket_revise`, `ticket_submit_candidate`, and `ticket_check_candidate`; attempts stay host-owned, and `ticket_report` takes the active `attempt_id`. Creation is restricted to the caller’s Session and coordinator identity; use handoff to transfer coordination. Cross-Session reads expose only Tickets where the caller coordinates or owns an assignment. There is no automatic event trigger.

#### Token effect

Ticket events are log-only and add no model tokens by themselves.

#### KV Cache effect

Ticket state changes do not alter request headers or model prompt prefixes.

## Known Limitations and Deferred Work

- The execution adapter owns Jobs and Worktree lifetimes in memory; the Ticket log retains the assignment and slot state, while provider-specific job and checkout recovery remains provider-owned.
- The package has no source admission policy or browser supervision UI. Consumers decide which Ticket commands and execution modes require human approval.
- Ticket snapshots reserve byte capacity for uncertainty, minimal settlement records, and a minimal Ticket cancellation summary before admitting more state. Attempt count uses `maxReports`; operations are bounded by snapshot bytes rather than report count. The `ticket-execution:` operation-id prefix is reserved for admitted execution facts. Operation fingerprints use SHA-256; retained JSON fingerprints remain readable. Settled attempts compact tagged operation records into one settlement record retaining retired ids and fingerprints; replay preserves those refusals, while settlement retries retain their fingerprint and durability check. Settlement records written before fingerprints were retained keep only ids, so a retry of one of their operations for the same attempt is acknowledged whatever its arguments. Historical untagged operations, reports, questions, and attention are not compacted.
- A damaged root with no recoverable Ticket placement cannot reserve an identifiable workspace; its recovery warning requires repair before resuming that root. Known reservations remain held. A closed root must be resumed before a settlement can be persisted; the outcome is held in memory until then, so an in-process attempt whose host exits first is recovered as `cancelled` and other placements stay reserved.
- The first shared-workspace admission after activation reads every stored root log once; cost grows with stored history until a compact reservation index exists.
- A Ticket is rooted in one Session log. Cross-Session replication and source-specific ingress remain adapter responsibilities.

<a id="dev-note"></a>
### Dev Note

This package is experimental and has no stability promise. Session events are the authority; projection checkpoints are only replay shortcuts.
