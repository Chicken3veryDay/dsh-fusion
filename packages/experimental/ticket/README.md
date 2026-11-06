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

The service exposes `create`, `assign`, `claim`, `release`, `report`, `ask`, `answer`, `closeQuestion`, `attention`, `acknowledgeAttention`, `resolveAttention`, `block`, `handoff`, `complete`, `fail`, and `cancel`. Mutating commands carry `expectedRevision`; a stale value returns `TICKET_STALE_REVISION` and leaves the newer state untouched. Workers are direct Session identities supplied by the execution adapter. The current coordinator answers open questions and acknowledges or resolves attention; question authors may also close their own open or answered questions. Acknowledgement retains the blocker. Worker progress, claims, and release preserve unresolved questions and attention; resolving the last blocker recomputes readiness from assignments. Finished or released assignments reject reports. A specification edit reopens completed contributions without attempt history for a fresh model report, retaining old reports as history. Assignments with attempts require a fresh host-admitted attempt; legacy claim cannot reopen them. Exclusive write assignments require a workspace-bearing attempt instead of a legacy claim. Candidate submissions naming assignments without current result reports return `TICKET_ACCEPTANCE` with the assignment identity. Required children constrain acceptance; unfinished, failed, or cancelled children do not prevent parent cancellation or failure.

Mount `TicketTools` when model callers should coordinate through `ticket_*` commands. Mount `TicketExecutionService` with Jobs and Worktree providers when an assignment needs a shared workspace, an isolated worktree, or owned background jobs. The execution adapter admits the durable attempt, checks the direct worker identity, and receives an attempt-bound recorder that serializes execution facts with all Ticket commands without caller CAS. Preparation must match any current initiating Agent. The recorder survives coordinator handoff and preparing Agent disposal. It preserves runtime identity and appends each job id to its receipt before starting the producer. Caller cancellation remains attached until producer settlement or successful handle cleanup; failed Jobs dominate cancelled Jobs, and either prevents success. Disposal requests cancellation before durable writes and awaits retained producer promises even after Agent cleanup removes their Job records. A pending or timed-out natural settlement can escalate to disposal. Cancellation or shutdown before any producer starts settles the attempt as cancelled, retaining any known workspace receipt. Uncertain resource creation remains unknown. Automatic owner-disposal callbacks do not retry a failed stop; explicit disposal and teardown may retry it. Once the producer outcome is known, Ticket owns the settlement until it is durable, as [the attempt state machine](#attempt-state-machine) describes; disposal of a handle whose root Session is closed rejects with the retryable `TICKET_SETTLEMENT_PENDING`, and resuming that root writes the settlement. When the admission's own flush fails, an identical `prepare` retry repeats the flush and continues preparation; if no retry comes, the caller's, worker's or root's disposal, or teardown, ends the attempt as cancelled. Repeating a settled preparation returns `TICKET_ATTEMPT_STATE`.

A package that owns coordination for a Session registers with `registerCoordinatorAuthority(authority)`, which returns the disposer. `create` asks each authority inside the Session's command queue, in the same synchronous step that reads the Session state and appends the Ticket. The authority receives the requested coordinator (`CreateTicketRequest.coordinatorId`, or the Session id when absent) and may return a replacement; the first replacement wins, so a Ticket created while coordination moves names the coordinator the authority decided at the append. An authority that throws a `TicketError` fails the creation with that error unchanged, such as a retryable `TICKET_COORDINATOR_UNAVAILABLE` from an authority that is still loading; any other exception returns `TICKET_RECOVERY_FAILED` with the original cause. Neither appends anything. A coordinator that is not a registered live Agent returns `TICKET_AUTHORITY` naming it, whether the authority selected it, and the remedy: resume that Agent, or hand coordination back to the Session owner.

The [Session projection](../../session/session-projection/README.md) is the browser-safe read path. Every `ticket/state` event carries the complete post-change value, so opening a Session or replaying its events produces the same state and rejects malformed or out-of-order revisions. Legacy v1 reports are projected onto the synthesized initial specification so retained results can enter a v2 candidate without rewriting old events. Command admission and replay share semantic validation; invalid commands append nothing. A proposed Ticket cannot complete directly. Persistence flush failures may occur after append and require reading the current revision before retrying. Idempotent attempt-operation retries flush the Session again before reporting success, including retries of an operation that settlement compacted into its attempt's tombstone; reusing such an id for another attempt returns `TICKET_ATTEMPT_STATE`.

Work scopes normalize slash-separated relative paths, collapse `.` and `..`, and reject workspace escapes, absolute paths, drive prefixes, and backslashes. An assignment scope must stay within a declared Ticket scope without escalating read access to write access; a Ticket with no declared scopes leaves assignment declarations unrestricted. Attempt admission atomically excludes overlapping write scopes when either declaration is exclusive in the same shared execution world. Scope checks and append run synchronously; unrelated roots do not wait for another root’s flush. Reservations survive root Session closure and remain held through stopping, unknown status, or failed settlement flushes. Activation reads no stored log. The first shared-workspace admission lists storage and folds only the `ticket/state` events of each stored root that is not live, without resuming producers; later admissions reuse that scan. A listing failure, or a stored root that cannot be read, refuses shared-workspace admission with `TICKET_RECOVERY_FAILED` naming the cause or root, and the next admission retries it. A root whose stored Session no longer exists releases its reservations. A live root that fails replay is reported against that root and retains its known scopes; unrelated scopes remain available. Isolated worktrees and distinct execution worlds remain independent; scopes do not confine filesystem access.

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
| `preparing` | `TicketExecutionService` reservation | The workspace is recorded (`running`); a certain failure or cancellation before any producer hands `failed` or `cancelled` to the ledger; an uncertain worktree or activation records `unknown`. If the admission flush fails, an identical retry continues, and the caller's, worker's or root's disposal or teardown hands `cancelled` to the ledger. |
| `running` | `TicketExecutionService` handle | `settle()`, `dispose()`, owner disposal or teardown observes every producer and hands the outcome to the ledger; a producer that does not settle within `settlementTimeoutMs` records `unknown`. |
| `unknown` | Host reconciliation | A host caller records the observed outcome with `settleAttempt`. |
| Outcome handed to the ledger | `TicketService` settlement ledger | The `settled` snapshot is appended to the live root and flushed. A closed root returns `TICKET_SETTLEMENT_PENDING`; resuming it replays the write. A failed flush is repeated by the next settlement retry or Ticket write on that root, and teardown makes one last attempt. |
| `settled` | None | Terminal. The scope reservation and ledger entry are released only by the flush that makes it durable. |

After a restart, a resumed root settles an attempt as `cancelled` when it is `preparing`, `running` or `stopping`, ran in process, carries execution stage facts, and no owner in this host admitted it, because its producer ended with the earlier host. Roots live when Ticket activates are left to their earlier owner. Manual attempts, admissions without stage facts, and dedicated-process or remote attempts stay reserved until a host caller settles them.

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
- Ticket snapshots reserve byte capacity for uncertainty, minimal settlement records, and a minimal Ticket cancellation summary before admitting more state. Attempt count uses `maxReports`; operations are bounded by snapshot bytes rather than report count. The `ticket-execution:` operation-id prefix is reserved for admitted execution facts. Operation fingerprints use SHA-256; retained JSON fingerprints remain readable. Settled attempts compact tagged operation records into one settlement record retaining retired ids; replay preserves those refusals, while settlement retries retain their fingerprint and durability check. Historical untagged operations, reports, questions, and attention are not compacted.
- A damaged root with no recoverable Ticket placement cannot reserve an identifiable workspace; its recovery warning requires repair before resuming that root. Known reservations remain held. A closed root must be resumed before a settlement can be persisted; the outcome is held in memory until then, so an in-process attempt whose host exits first is recovered as `cancelled` and other placements stay reserved.
- The first shared-workspace admission after activation reads every stored root log once; cost grows with stored history until a compact reservation index exists.
- A Ticket is rooted in one Session log. Cross-Session replication and source-specific ingress remain adapter responsibilities.

<a id="dev-note"></a>
### Dev Note

This package is experimental and has no stability promise. Session events are the authority; projection checkpoints are only replay shortcuts.
