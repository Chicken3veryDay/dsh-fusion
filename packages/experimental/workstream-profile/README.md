---
description: "Enable the Ticket, Workstream, and Workstream Evidence services and their model tools with one experimental profile layer."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-workstream-profile

English | [中文](README.zh.md)

## Summary

`dsh-experimental-workstream-profile` mounts the [Ticket](../ticket/README.md), [Workstream](../workstream/package.json), and [Workstream Evidence](../workstream-evidence/package.json) services and registers their `ticket_*`, `workstream_*`, and `workstream_evidence_*` model tools. Tickets are the only work board; Workstream adds members, coordinator handoff, and acknowledged messages; Evidence adds immutable shared artifacts; a [Web panel](../client-ui-workstream/README.md) shows them and answers Ticket questions. Agent Teams is not mounted. The layer ships unlisted and is added only to an initialized profile.

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

### Install into a profile

```sh
dsh plugin --profile headless add @deepseek-ai/dsh-experimental-workstream-profile
dsh --profile headless "Open a Workstream, create a Ticket, and assign it to a new member."
```

The profile must already contain `@deepseek-ai/dsh-base`, whose Session, Subagent, and attachment services this layer consumes. `dsh plugin --profile <name> remove @deepseek-ai/dsh-experimental-workstream-profile` removes the layer.

### What you get

The patch inserts three services, three tool rows, and the Web panel after `dsh-base`:

| Row | Mounts | Model tools |
|---|---|---|
| `tickets`, `tool-ticket` | `ctx.tickets` | `ticket_*` |
| `workstreams`, `tool-workstream` | `ctx.workstreams` | `workstream_*` |
| `workstream-evidence`, `tool-workstream-evidence` | `ctx.workstreamEvidence` | `workstream_evidence_*` |
| `ui-workstream` | `ctx.workstreamPanel`, Web header action | — |

Every service limit is an explicit Config value in the patch, equal to the package default.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The runtime content is [`cordis.patch.yml`](cordis.patch.yml). The three tool classes are named exports of their packages, and the Loader mounts only a module's default export, so this package re-exports each as the default of a one-line entry: `./ticket-tools`, `./workstream-tools`, and `./workstream-evidence-tools`.

Agent Teams stays unmounted. `WorkstreamService` delivers messages, interruption, and stop through `ctx.subagents` inbox delivery and records durable acceptance receipts, so it needs no Team roster or `ctx.agentTeams`. Mounting Agent Teams would add a second `team_task_*` board beside Tickets. The base `subagent`, `list_agents`, and `send_message` tools stay available and bypass Workstream authorization; use `workstream_*` tools for Workstream members.

`TicketExecutionService` is not mounted: it needs Worktree providers that the base profile does not supply.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Ordered patch over `dsh-base` |
| [`src/ticket-tools.ts`](src/ticket-tools.ts), [`src/workstream-tools.ts`](src/workstream-tools.ts), [`src/workstream-evidence-tools.ts`](src/workstream-evidence-tools.ts) | Default-export Loader entries for the tool classes |
| [`tests/composition.spec.ts`](tests/composition.spec.ts) | `dsh` process test: services and model-visible tool list, with and without the layer |
| [`tests/profile.spec.ts`](tests/profile.spec.ts) | Patch shape, default exports, and absence from shipped compositions |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Experimental packages](../README.md) — incubation status and publication policy.
- [Ticket](../ticket/README.md) — the durable work item service and its tools.
- [Agent Teams profile](../agent-team-profile/README.md) — the Team task board alternative.
- [Base bundle](../../bundle/base/README.md) — the profile layer this patch extends.

-----

<a id="model-experience"></a>
## Model Experience

### Ticket, Workstream, and Evidence tools

#### What the model sees

The 35 `ticket_*`, `workstream_*`, and `workstream_evidence_*` tool schemas, plus the `ticket-tools:policy` system-prompt section registered by `TicketTools`. This layer adds no text of its own.

#### Token effect

The layer adds the tool schemas and one policy section of the three packages.

#### KV Cache effect

The system prompt and tool schemas stay prefix-stable while the patch and configured tools are unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Opt-in only** — no shipped CLI, Web, SDK, ACP, or Python profile enables it.
- **No execution service** — Ticket attempt execution with Jobs and Worktree providers is not mounted.
- **Base profile required** — the patch depends on services supplied by `dsh-base`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
