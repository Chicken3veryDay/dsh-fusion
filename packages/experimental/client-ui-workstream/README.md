---
description: "Use and debug the experimental Web Workstream panel for questions, Tickets, members, change requests, and evidence files."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-workstream

English | [中文](README.zh.md)

## Summary

This package adds a Workstream action to the Web conversation header. Its panel has five views: Needs you, Work, Team, Changes, and Files. It reads the Workstream root Session's `workstream`, `ticket`, and `workstreamEvidence` projections from the shared Session store, so the panel updates through Host projection frames. Needs you answers and closes Ticket questions and acknowledges and resolves attention items through a Host Remote that acts as the displayed Session. Changes reads the change requests that Workstream members bind. Choose it through the experimental Workstream profile layer.

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

Enable this package through [`@deepseek-ai/dsh-experimental-workstream-profile`](../workstream-profile/README.md), which supplies the Ticket, Workstream, and Workstream Evidence services and this panel together. The Web Client loader mounts the `/client` export, and the Host loads the root export as the `workstreamPanel` Remote. The package has no user configuration fields.

The header action appears only in a conversation whose Workstream root projects a Workstream: the owner Session, or a member opened as a continuable child of the owner. Its badge counts the items in Needs you. Clicking the action opens the panel; outside clicks and Escape close it.

### Act on questions and attention

Needs you lists open questions and unresolved attention items of Tickets that have not ended, oldest first. A question card has an answer field, Send answer, and Close question. An attention card has Acknowledge until it is acknowledged, and Resolve. Each command carries the Ticket revision that the panel displayed. When another change committed first, the card shows a conflict notice, the panel rereads the root projections, and the next attempt uses the current revision. Permission, availability, and Ticket validation failures stay visible on the card that caused them.

The Ticket service decides who may act. Answers, acknowledgements, and resolutions require the Ticket coordinator, so a member conversation that does not coordinate the Ticket shows a permission notice. A question's author may also close it.

### Inspect Work, Team, Changes, and Files

- **Work** shows Mission plans with per-milestone completion counted from Ticket statuses, then every Ticket with its status, coordinator, dependencies, and assignments.
- **Team** shows every member with role, coordinator marker, phase, description, and diagnostic. Selecting the owner opens the owner Session; selecting another member opens its continuable child address. The current conversation and provisioning members cannot be selected.
- **Changes** reads the aggregated change requests when the view opens and on Reload. Each entry links to its web page and lists the Sessions that bind it. When a Session or the forge service could not be read, a notice states that the list may be incomplete and gives the reasons.
- **Files** shows each evidence artifact with every retained version's number, size, author, and digest prefix. The panel does not read artifact content.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`WorkstreamPanelController` is a `TypertRemoteService` with one Agent lookup parameter per method, so the Gateway resolves the displayed Session and access-checks it as that Session's resource. No wire field names a second Session. The controller derives the Workstream root from the caller's own Session header, calls `ctx.workstreams.requireMembership` with the live caller, and runs `ctx.tickets.answer`, `closeQuestion`, `acknowledgeAttention`, or `resolveAttention` on the root's Ticket log with the caller as actor. `changeRequests` returns `ctx.workstreamEvidence.aggregateChangeRequests` for the same caller and root. Ticket and Workstream failures become `workstreamPanel/stale-revision`, `workstreamPanel/denied`, `workstreamPanel/unavailable`, or `workstreamPanel/rejected`; other failures propagate unchanged.

The Client export mounts the generated Remote, then registers its locale dictionaries and one conversation-header slot; disposal withdraws the slot before the Remote. A stale-revision failure calls `sessions.refreshProjections` on the root before the card shows the conflict.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Host Remote and failure mapping |
| [`src/types.ts`](src/types.ts) | Browser-safe Remote requests and failure codes |
| [`src/client/mount.ts`](src/client/mount.ts) | Remote, locale, navigation, and slot registrations |
| [`src/client/WorkstreamAction.tsx`](src/client/WorkstreamAction.tsx) | Header action, panel, and view selection |
| [`src/client/views.tsx`](src/client/views.tsx) | The five views and their command cards |
| [`src/client/model.ts`](src/client/model.ts) | Needs you items and Mission progress derived from Tickets |
| [`src/client/locales.ts`](src/client/locales.ts) | Panel copy in eight languages |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workstream profile layer](../workstream-profile/README.md) — the opt-in layer that mounts this panel.
- [Ticket service](../ticket/README.md) — Ticket state, commands, and authority rules.
- [Workstream service](../workstream/README.md) — membership and coordinator handoff.
- [Workstream Evidence](../workstream-evidence/README.md) — evidence versions and change request aggregation.
- [Experimental packages](../README.md) — incubation status and publication policy.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through Ticket answers and attention changes that agents read with the Ticket tools; the Ticket service owns that text.

#### KV Cache effect

The panel appends no model input. A committed command changes Ticket state, which reaches a model only when an agent reads the Ticket later.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Coordinator-only answers** — the human acts as the displayed Session, so answering requires opening the Ticket coordinator's conversation, usually the owner.
- **Live owner required** — commands and Changes need the owner Session to be loaded; otherwise the panel shows an unavailable notice.
- **No Ticket or member management** — the panel cannot create, assign, end, or hand off Tickets, add or stop members, or send peer messages.
- **Metadata-only files** — Files lists evidence versions without opening or downloading their content.
- **Change request reads on demand** — Changes does not follow forge polling; use Reload to read again.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
