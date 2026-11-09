---
description: "Automation-only ACP (Agent Client Protocol) server for programmatic clients and maintainers driving DeepSeek Harness agents over JSON-RPC stdio."
kind: "package-reference"
---

# @deepseek-ai/dsh-acp

English | [中文](README.zh.md)

## Summary

`dsh-acp` lets trusted programs automate persistent DeepSeek Harness agents through the standard [ACP](https://agentclientprotocol.com): create or resume sessions, select a model and reasoning effort, attach MCP servers, submit or cancel work, receive semantic updates, and close sessions independently. Choose it for out-of-process subagents, test runners, and scripted controllers; it intentionally omits DSH-specific presentation data and interactive UI features. Persistence supports listing, resuming, and closing sessions across process restarts, but deletion, forks, transcript replay, and additional directories are unsupported. Run `pnpm dsh --profile acp` to start the server; use `dsh-subagent-acp` as the repository client.

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

Use this package when a script, test runner, or another harness needs to run agent work end to end through a standard automation protocol. The common path is: start the server, create or resume a session, optionally mount MCP servers and select model options, send a prompt, consume semantic updates, and close the session.

### When to choose it

Choose it when automation should own the interaction: an out-of-process subagent, test runner, or scripted controller that manages persistent sessions, tools, model selection, and permissions. Avoid it when a human needs DSH-specific presentation cards, plans, titles, todos, terminal views, or elicitation; this server intentionally exposes only the standard ACP v1 surface.

### Minimal configuration

Every session the server creates uses the provider and model configured here. Both fields are optional so another agent or request listener can supply them; the runnable demo composition sets both. Stdout carries only protocol traffic, so keep logging off it.

```yaml
- name: '@deepseek-ai/dsh-acp'
  config:
    provider: deepseek-official
    model: deepseek-v4-pro
```

| Field | Default | Meaning |
|---|---|---|
| `provider` | — | Provider route for every session's agent |
| `model` | — | Model for every session's agent |
| `sessionListPageSize` | `100` | Maximum summaries returned in one `session/list` page |
| `goalReasonCodeLimit` | `64` | Longest goal block reason code, in UTF-16 code units, that the goal runtime context prints; a positive integer |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-acp) is the exhaustive source for every accepted field and its JSDoc.

### Start a server

`pnpm dsh --profile acp` starts the shipped stdio server. The `acp` profile mounts session persistence, so clients can list, resume, and close persistent sessions. [`@deepseek-ai/dsh-subagent-acp`](../../subagent/subagent-acp/README.md) starts the same profile for out-of-process delegation.

<a id="protocol-contract"></a><a id="standard-acp-v1-surface"></a>
### Protocol contract

One connection can run several sessions at once, each independent. The calls a client makes:

| Call | What you get |
|---|---|
| `initialize` | Stable ACP v1 plus `session/list`, `session/resume`, `session/close`, and Streamable HTTP MCP support; image prompts only when the durable attachment store and configured exact route support them. |
| `authenticate` | Immediate success; the server requires no authentication. |
| `session/new` | A fresh persistent agent whose absolute workspace and stdio or HTTP MCP servers are validated before publication, plus its complete configuration-option state. |
| `session/list` | Deterministic newest-first pages of persisted, resumable root sessions; an optional absolute `cwd` filter uses physical-directory identity where possible. |
| `session/resume` | A persisted inactive session whose canonical workspace is verified before composition; its log is restored without replaying old updates. |
| `session/close` | Quiescent cancellation, update draining, descendant disposal, persistence flush, and disposal of only the addressed Agent scope. |
| `session/set_config_option` | A serialized update to the advertised `model` or `reasoning_effort`, returning the complete resulting state. |
| `session/prompt` | Ordered text, resource links, and supported images, one prompt at a time per session; settlement follows root and descendant completion plus ordered update delivery. |
| `session/cancel` / `$/cancel_request` | The prompt-owned cancellation path; without an ACP prompt in flight it cancels autonomous work, while unknown session ids are no-ops. |
| `session/update` | Committed assistant messages and thoughts, generic tool lifecycle (including calls made inside a `run_code` program), configuration changes, and context usage, serialized per session. |
| `session/request_permission` | A permission prompt with one-shot allow/reject choices; your client can answer automatically. |

Session listing and resume admit ordinary forks, including historical logs with `parentSession`; `origin: subagent` remains excluded.

A prompt remains in flight while managed descendants run, while their results trigger later root turns, and while committed output drains. Root work accepted during that output drain joins the same activity interval before completion. Its completion includes the latest root stop reason and any assistant output delivery failure; only the original prompt turn pins the model selection captured at admission. Cancellation stops the root activity present at that call and waits for that activity and its queued output. Later child messages may start autonomous work and do not delay the cancelled response; the session remains available for later prompts. Idle descendants with parked inbox messages remain resident but do not delay prompt completion. Closing the session also drains its descendants.

A failure to append `turn/start` or `turn/end` rejects the prompt even when a preceding turn completed.

Without a model selection, configuration returns no options and skips catalog access. A configuration request cancelled before admission rejects before catalog access. Session configuration offers opaque provider/model choices from the live LLM service catalog and a `reasoning_effort` selector when the exact model declares one. A `model` change accepts exactly an opaque value the server produces, for a registered provider whose adapter lets an interface select that model (the LLM service's `canSelectModel`), or the current selection; it makes no catalog listing for an adapter that answers locally, so a previously offered model stays selectable while its provider's listing fails. The state a change returns re-projects the latest listed catalog instead of listing again. An option change records the Session selection and takes effect at the next model step, including a continuation in the current turn; an already prepared step and its retries keep their captured selection. Image admission checks the selection current when admission begins. Resume restores a recorded selection even when no request has used it yet. ACP clients are trusted controllers: stdio MCP entries authorize their absolute commands and environment, HTTP entries authorize their absolute HTTP(S) URLs and headers, and any initial connection or discovery failure rolls back the unpublished Agent. Unsupported surfaces are omitted or rejected: `session/load`, deletion, fork, additional directories, SSE or ACP-transport MCP, modes, commands, plans, terminals, client filesystem operations, and elicitation.

<a id="recipient-and-latest-input-context"></a>
### Recipient and latest-input context

Every request of a session's Agent also carries one generated `acp-context` message after the admitted client input. It declares the fixed recipient class `ACP automation` for that session and names the message id of the latest client input this server admitted. Goal state is not packet text: an `acp:goal` runtime-context section states the phase, round counts, and a block reason code when it is at most `goalReasonCodeLimit` characters (a longer code is replaced by an explicit omission with its length), or `unavailable` when no goal service is mounted. Nothing in the request format changes: the client sends the same `session/prompt`, and a role stated in prompt prose does not change the recipient class.

The admitted input keeps `source.kind: 'user'`, its exact content, and an `input: { kind: 'acp' }` annotation; the packet is a `snapshot`-form fact that grants no authority. A newer input moves the reference only. It does not replace, expire, or reinterpret an earlier instruction, and it creates no goal or task. Input without the annotation, including older history and goal continuations, is never attributed to this channel: while no tagged input exists the packet reports the latest input as unknown. Tool continuations and retries repeat nothing; a new packet is logged when its facts change or compaction removes it from the conversation. Spawned and forked Agents do not receive the packet as their own recipient declaration.

The packet is operational context. It does not assign a worker or reviewer role, identify a task, or reduce the instructions the Agent receives; `dsh --profile acp` loads workspace instructions in [strict mode](../../context/agent-instructions/README.md#strict-loading), which keeps every applicable rule whole or refuses the request before dispatch.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the server realizes the behavior above and points at the code that implements it; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The server is an automation transport with an intentionally standard public protocol. Three commitments shape it:

- **Standard semantic updates only.** The wire carries committed messages and thoughts, generic tool lifecycle, configuration, and context usage; raw provider deltas, retry attempts, DSH presentation data, and unsupported content stay off the wire.
- **Truthful capability and configuration state.** `initialize` advertises only mounted support, topology changes publish complete configuration options, and a prompt pins the exact route it admitted.
- **Quiescence before settlement.** Prompt and close operations settle only after their owned admission, Agent activity, ordered updates, descendants, persistence, and disposal have reached the required terminal state.

The decision history lives in the [ACP as an automation-only protocol note](../../../.agents/notes/implemented/simplification/2026-07-23-acp-automation-only-protocol.md) and the [multi-session note](../../../.agents/notes/archived/feature/2026-06-14-acp-multi-session.md).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, `AgentSideConnection` wiring, per-session records, admission and settlement, teardown |
| [`src/content.ts`](src/content.ts) | Wire-content admission and projection: image validation, route recheck, prompt reconstruction, assistant block conversion |
| [`src/codec.ts`](src/codec.ts) | Pure turn-ending to ACP `stopReason` mapping |
| [`src/context.ts`](src/context.ts) | Recipient/latest-input/goal packet provider, its `acpContext` projection, and the `acp-context` message source |

### Admission and prompt settlement

Each session permits one in-flight prompt. Admission validates the whole prompt batch, snapshots the selected route, rechecks the exact Agent identity and image capability, persists image attachments, and only then queues the user message — a cancellation that wins admission never enqueues a late turn. Once queued, the session module associates the snapshot with the inbox message until claim and pins the same provider, model, and reasoning effort across prompt variables and every model step in that turn. Per-session update delivery is serialized; committed images are re-read and integrity-verified, so a missing or corrupt image in an assistant message fails the correlated prompt instead of emitting a placeholder. A tool result image that cannot be read is replaced by the text `[Image unavailable: the attachment could not be read.]`, so the call's terminal `tool_call_update`, nested or not, still arrives with the tool's own status. Settlement precedence is explicit cancellation, committed-output failure, interval-wide Agent failure, then the correlated turn ending.

### Recipient context

`AcpSession` stamps only input that passed content admission, using the existing user-message path. The plugin registers one host-only `acpContext` projection that retains the latest tagged input reference and the newest packet's text and position; the first request reads the pending tagged input, later attempts read the committed projection. Each Agent receives its own `system-prompt/request-context` listener and its own `acp:goal` runtime context through its unpublished scope. The packet holds only stable facts and is returned uncommitted; the loop alone logs it after provider preparation, so cancellation records neither a packet nor a pointer. The goal context declares a `revision` equal to its text, which request admission reads again in the step that freezes the request: a goal change at the last admission await restarts the attempt with the current text, and a second change fails the request before dispatch ([agent-loop admission](../../core/agent-loop/README.md#understand-the-implementation)). `apply` awaits the projection registration, so a registration failure fails plugin activation, and an unload during the wait settles before the server, handlers, or transport exist.

### Teardown and connection ownership

Each session module owns its Agent handle, MCP mounts, future and turn-pinned model selections, prompt slot, update chain, and memoized close operation. Explicit close, client disconnect, and Cordis disposal use the same quiescent teardown: stop new work, cancel prompt admission and Agent activity, drain committed updates, dispose continuable descendants child-first, flush persistence, and release the owned Agent scope. A session close leaves persisted state available for list and resume, and other sessions or frontends sharing the Context remain untouched.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the matching client to the design records behind the automation contract.

- [dsh-subagent-acp](../../subagent/subagent-acp/README.md) — the out-of-process ACP client that spawns and drives this server.
- [ACP as an automation-only protocol](../../../.agents/notes/implemented/simplification/2026-07-23-acp-automation-only-protocol.md) — the design record for the automation contract and its wire boundaries.
- [Multiplex concurrent ACP sessions over one connection](../../../.agents/notes/archived/feature/2026-06-14-acp-multi-session.md) — per-session isolation, ownership, and teardown decisions.
- [Extension cookbook](../../../docs/cookbook/extension-cookbook.md) — this package as the automation-only worked example for extension authors.

-----

<a id="model-experience"></a>
## Model Experience

### Recipient, latest-input, and state context

#### What the model sees

One short user-role snapshot after each new client input, fixed in this form: the heading line marking it as generated facts with no authority, the recipient declaration with the session id, the latest client input as `message <id>` with whether its text is still in the conversation, and a pointer to the runtime context for directory, sandbox, approval, delegation, goal, and plan facts. The runtime context carries one `Goal:` line without the objective. A repeated request or tool continuation sees the same single packet.

#### Token effect

About 100 tokens per logged packet and about 20 for the goal line, plus a block reason code of at most `goalReasonCodeLimit` characters. The packet is logged again only when the latest input or its compaction state changes; the goal line rides in the runtime-context snapshot, which is logged again only when a fact in it changes.

#### KV Cache effect

Append-only: a packet joins the history after the client input it names, and a goal change appends a new runtime-context snapshot; an unchanged state adds nothing.

### Prompt content

#### What the model sees

`session/prompt` preserves text and image order in one user message: adjacent text concatenates, and a resource link appears as a bracketed `[resource_link name=… uri=…]` reference the model may open with its own tools. Inline image base64 is discarded after batch admission, so the durable message contains only verified attachment references. Protocol metadata, client capabilities, permission choices, and session ids never enter the model request.

#### Token effect

Prompt content, tool calls/results, and durable image references remain in that session until compaction. Concurrent sessions retain independent contexts.

#### KV Cache effect

Append-only while the selected route and assembled prefix stay unchanged. A model change starts the next ACP turn on the new route.

### Permission decisions

#### What the model sees

Nothing directly. The owning tool records its allowed, rejected, cancelled, or unavailable outcome through the normal tool-result path.

#### Token effect

Only the owning tool result contributes tokens.

#### KV Cache effect

Append-only through the owning tool result.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this package is a poor fit or needs special operational care. They are current package constraints, not a protocol comparison or a task backlog.

- **One primary workspace** — additional directories remain unsupported.
- **Raster prompt images only** — PNG, JPEG, WebP, and GIF require a durable attachment store and an exact image-capable route.
- **MCP tools only** — MCP resources and prompts have no DSH consumer.
- **Nested `run_code` calls are parented by `_meta`** — a call made inside a `run_code` program arrives as its own `tool_call` and `tool_call_update` keyed by its sub-call id (`<run_code id>:ptc:<n>`), with `_meta["dsh/parentToolCallId"]` naming the program call, because ACP has no parent field. A program that requests a wider sandbox mode raises one permission request for that execution, naming the `run_code` call, whose `tool_call` update (titled `run_code`, input carrying the program description and the requested sandbox mode and justification) precedes it; the request carries no separate reason text. Nested tools keep their own policies, so a nested call can raise its own permission request after its own `tool_call`.
- **Recipient context is not task curation** — the packet names the latest admitted client input and goal phase. Worker or reviewer assignment, task identity and replacement, work scopes, curated optional evidence, and meaningful instruction reduction remain future work, and earlier lossy compaction of older user instructions keeps its existing semantics.
- **No transcript replay or interactive extensions** — session deletion, fork, `session/load`, modes, commands, plans, terminals, client filesystem operations, and elicitation remain outside this automation surface.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
