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

Mount this opt-in host service alongside `agents`, `sessionPersistence`, `sessionProjections`, `fusionConfig` and `agentPresets`. It has no configurable fields. The owning host calls `ctx.fusionParticipants.prepare(selectionId)` or `recover(rootSessionId)`, then retains the returned `PreparedParticipants` capability until task disposal. `adopt(role)` returns a parked Agent; disposing that Agent preserves its Session and writer for another adoption. Dispose the task to drain Agents, remove routing and close writers.

Preparation failures expose `ParticipantPreparationError.rootSessionId` for recovery and report whether cleanup completed or remains unknown. Retry recovery using that root identity after resolving the cause; starting another preparation creates a different task. Missing or corrupt established histories block recovery rather than allocate replacement contexts.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The root lease precedes participant acquisition in persisted identity order. Required log-only records retain the immutable roster and successful provisioning evidence. Each retained Session passes the persistence owner's same-writer durability barrier before preparation succeeds. Agent adoption borrows that exact registered Session through the existing loop factory. A retained preset scope keeps the composed generation alive independently of resident Agents; generation identities bracket the declaration digest read so a concurrent replacement refuses preparation.

| Source | Responsibility |
|---|---|
| [src/index.ts](src/index.ts) | Host lifetime, preparation, recovery and composition |
| [src/roster.ts](src/roster.ts) | Immutable membership and exact binding parser |
| [src/state.ts](src/state.ts) | Validated root recovery projection |

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

Preparation and adoption send no model input. `fusion/roster` and `agent/runtime-owner` events are log-only; continuations retain the participant's own history and selected preset composition.

#### Token effect

No inference requests occur during preparation, publication or recovery. Future activation and delivery require separate authorization.

#### KV Cache effect

This package preserves context lineage across Agent detachment and never copies another participant's transcript. Provider cache availability and eviction remain outside its contract.

## Known Limitations and Deferred Work

- Product activation, input delivery and deduplication, execution grants, containment and final decisions belong to downstream owners. No activation control is exported to model or guest tools.
- Recovery requires the matching preset declaration; edited compositions refuse preparation. This package retains no historical preset catalog or plugin database.
- The host handles task disposal rejection after every retained Agent, child plugin, composition scope and writer has settled. Cleanup failures remain unknown, including earlier direct disposal; repeated disposal retains the causes and disposed tasks refuse adoption.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
