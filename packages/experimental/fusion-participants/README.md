---
description: "Prepare retained Fusion participant contexts and recover their immutable membership without starting model work."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-fusion-participants

English | [中文](README.zh.md)

## Summary

Prepare durable participant contexts before publishing parked Agents. A task retains its root roster and exact participant writers across Agent detachment, and recovery uses the original identities and recorded routes. Explicit role links share context; independently selected roles keep separate histories. Preparation and publication do not start turns or claim queued input.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this opt-in host service alongside `agentLoop`, `agents`, `sessions`, `sessionPersistence`, `sessionProjections`, `fusionConfig` and `agentPresets`. It has no configurable fields. The owning host calls `ctx.fusionParticipants.prepare(selectionId)` or `recover(rootSessionId)`, then retains the returned `PreparedParticipants` capability until task disposal. `adopt(role)` returns a parked Agent; disposing that Agent preserves its Session and writer for another adoption. Dispose the task to cancel and drain its work before removing routing and closing writers. The initiating caller scope owns cancellation and joining; the Fusion owner retains all leases and compositions independently of that caller.

`PreparedParticipants.delivery` admits typed user text or authenticated live peer text to a roster participant without adopting or waking an Agent. Construct `DeliveryId` once at host ingress and reuse it on retries. Identical retries preserve the order, revision and MessageId; changed content, origin or routing conflicts. All ordinary text, including `ok`, stays blocking and unclassified after transport completion. `snapshot()` returns immutable input facts and synchronous pending reservations; it performs no I/O.

Root intent durability precedes receiver acceptance and inbox insertion. The receipt follows verified receiver and root completion barriers; it promises one logical instruction, never inference or effect settlement. `reconcile()` repairs acceptance-only prefixes from retained text and source metadata, without reinserting consumed or canceled messages. Recovery reconciles before publication; adoption shares the same task order. `DeliveryBlockedError` retains the original identity for reconciliation. A pre-aborted caller signal admits nothing. After synchronous reservation, aborting rejects only that caller’s wait with its abort reason; the task continues delivery, including queued sends, and other callers remain independent. Retry the same DeliveryId to obtain the receipt; cancellation does not retract the reserved input. Task disposal cancels publication and drains transport before closing writers.

`PreparedParticipants.execution` returns deeply immutable authority facts only. Preparation and recovery durably open a fresh, closed incarnation; historical grants never authorize work. Default compositions install no execution issuers or effect adapters, so execution remains blocked by `integration-missing`. The snapshot exposes no run, grant, controller or model-executable callback.

An explicit trusted host calls `registerExecutionHost(task, provider)` with the exact prepared object. One provider and declaring caller fiber own that connection for its entire incarnation; identical retries join, while copies and replacement providers or fibers refuse. Enrollment re-pins the exact retained root and sorted participant writers after empty-open reservations have been released. Caller withdrawal closes admission and joins cleanup. The host retains its opaque issuer, controller, run and held-attempt objects in process; IDs, snapshots, property copies and proxies cannot reconstruct them.

Grant mutation ownership before binding its run. `reserve(run, operation)` synchronously returns a new logical request token; retain that token for registration and release retries. `register(attempt)` memoizes dormant held identity allocation, without preparation, payload entry or inference. Its independent cancellation and cleanup anchor must be available before preparation allocates resources. `release(attempt)` memoizes preparation, original-session start durability, synchronous owner invocation, independent cleanup and original-session result durability. The provider returns an inert synchronous invocation leaf after finishing asynchronous guards; the owner rechecks current host classification, exact identities, generation, revocation and all writer lifetimes, consumes dispatch, then enters that leaf without an intervening await. Throwing entry consumes dispatch and leaves its outcome unknown. Held cancellation needs no release call; successor grants retain task lifetime pins and wait for admitted cleanup and result durability.

The private execution owner reserves exact provider writers synchronously, persists originating start records before dispatch, and checks live run, generation, policy and writer admission at the final synchronous invocation. Revocation cuts admission immediately, then durably records the cut and joins admitted work, cleanup and result durability before a successor grant. Unknown outcomes or failed durability retain writer ownership and refuse successful disposal. Recovery folds required log-only facts without replaying effects; independent reconciliation records evidence without inventing a producer settlement. Task disposal joins execution and existing delivery before releasing retained writers.

The persisted `openingId` is a fresh task-opening nonce, not an OS boot identity. Boot-qualified containment identities and real effect adapters remain downstream requirements. Known partial initialization rolls back writer reservations before rejection. Disposal memoizes its join before callbacks and removes lifetime listeners; transport failure with retained execution writers blocks release. Failed reconciliation retains its reservation and unknown producer outcome.

Preparation failures expose `ParticipantPreparationError.rootSessionId` for recovery and report whether cleanup completed or remains unknown. Retry recovery using that root identity after resolving the cause; starting another preparation creates a different task. Missing or corrupt established histories block recovery rather than allocate replacement contexts. Missing, malformed or duplicate ownership and roster records also refuse recovery; required lifecycle records make older stock readers refuse managed histories before activation.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The root lease precedes participant acquisition in persisted identity order. Required log-only records retain the immutable roster and successful provisioning evidence. Each retained Session passes the persistence owner's same-writer durability barrier before preparation succeeds. Agent adoption borrows that exact registered Session through the existing loop factory. An observed resource scope captures the constructor owner context and adopts its exact Cordis disposer into ordered cleanup. Pending operations reserve their work boundary before provider callbacks; rollback and task release wait for every admitted operation to stop using resources. The explicit loop dependency retains the factory during direct loop teardown. A retained preset scope keeps the composed generation alive independently of resident Agents; generation identities bracket the declaration digest read so a concurrent replacement refuses preparation.

| Source | Responsibility |
|---|---|
| [src/index.ts](src/index.ts) | Host lifetime, preparation, recovery and composition |
| [src/roster.ts](src/roster.ts) | Immutable membership and exact binding parser |
| [src/state.ts](src/state.ts) | Validated root recovery projection |
| [src/delivery.ts](src/delivery.ts) | Dormant text admission and reconciliation |
| [src/delivery-state.ts](src/delivery-state.ts) | Required delivery records and permanent input identities |
| [src/execution.ts](src/execution.ts) | Closed task authority, writer reservations and effect cleanup |
| [src/execution-state.ts](src/execution-state.ts) | Required execution history and recovery validation |
| [src/task-order.ts](src/task-order.ts) | Shared private task ordering |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Fusion configuration](../../preset/fusion-config/README.md) — captured role selections.
- [Agent loop](../../core/agent-loop/README.md) — retained Session adoption.
- [Session persistence](../../session/session-persistence/README.md) — writer durability.

<a id="model-experience"></a>
## Model Experience

### Parked participant contexts

#### What the model sees

Preparation and adoption send no model input. `fusion/roster`, `agent/runtime-owner` and `fusion/execution-opened` are required log-only events; continuations retain the participant's own history and selected preset composition.

#### Token effect

No inference requests occur during preparation, publication or recovery. Delivery only queues text; activation requires separate authorization.

#### KV Cache effect

This package preserves context lineage across Agent detachment and never copies another participant's transcript. Provider cache availability and eviction remain outside its contract.

## Known Limitations and Deferred Work

- The public host connection relies on cooperating host providers. It supplies no native containment, job registry, QuickJS runtime, finalization scheduler or successful unknown-outcome recovery. Unknown cleanup, cancellation, invocation or durability retains reservations and blocks grants/disposal with causes; retries never replay payloads. Existing independent effect reconciliation facts do not certify native cleanup, and the public host exposes no recovery operation. A throwing held allocator cannot supply an independent cleanup anchor and therefore leaves the task blocked.
- Product activation, input classification and disposition, execution grants, containment and final decisions belong to downstream owners. No activation control is exported to model or guest tools.
- The opt-in owner closes admission synchronously on teardown, joins pending preparation and recovery, and drains all published task work before releasing retained writers. Root, owner, caller, loop and persistence teardown share this order. A nonsettling operation keeps graceful teardown pending; forced process termination remains crash-equivalent. Raw Cordis disposal logs cleanup failures; observed scope cleanup and task disposal reject with retained causes.
- Detaching an originating Session before settlement can prevent its required result append. Cleanup remains blocked and retains writers; recovery never invents the missing producer record.
- Recovery requires the matching preset declaration; edited compositions refuse preparation. This package retains no historical preset catalog or plugin database.
- The host handles task disposal rejection; execution uncertainty retains task writers until independently established recovery or process exit. Cleanup failures remain unknown, including earlier direct disposal; repeated disposal retains the causes and disposed tasks refuse adoption.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
