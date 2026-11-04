# DeepSeek “super agent” review

Date: 2026-11-03

## Scope and interpretation

“DeepSeek super agent” most plausibly refers to dsh-superagent, the public DeepSeek repository at https://github.com/deepseek-ai/dsh-superagent-prototype. Its README describes a proactive coding agent that watches one GitHub repository, optionally Feishu, creates durable work items, runs each item in its own agent Session and directory, and reports through the source conversation. The README explicitly says it is a research prototype, not an official DeepSeek product, not production-ready, and different from the internal system and the paper it references.

There are two related directions. DeepSeek Harness is the host: its official product page describes an open-source, public-preview, composable-plugin runtime for everyday work, coding, research, background tasks, and plugins. Dsh-superagent is a workload/plugin: it adds proactive intake, policy-gated admission, durable Tickets, per-ticket Executors, source adapters, a supervision panel, and limited human notifications.

The useful target is therefore the operating model and domain vocabulary, not a wholesale code copy.

## Primary-source inventory

| Source | Evidence | What it establishes |
| --- | --- | --- |
| https://github.com/deepseek-ai/dsh-superagent-prototype | Current repository README | Scope, research-only status, MIT license, GitHub/Feishu intake, per-work-item Sessions/directories, panel, and explicit warning that publication differs from the internal system/paper. |
| https://raw.githubusercontent.com/deepseek-ai/dsh-superagent-prototype/main/docs/000-philosophy.md | Current main | Take as little human attention as possible; act only when asked or permitted; speak only when a person must act or can use a result; ask one concrete question; start proactive work in observe-only mode. |
| https://raw.githubusercontent.com/deepseek-ai/dsh-superagent-prototype/main/docs/001-domain.md | Current main | Source, Trigger, Thread, Eval, Mandate, Subscription, Ticket, Assignment, Executor, and Channel flow; stable Trigger identity and one Eval per Thread. |
| https://raw.githubusercontent.com/deepseek-ai/dsh-superagent-prototype/main/docs/002-authorization.md | Current main | Explicit versus inferred requests, subscription context without authority, follow-up ownership and hand-back, off/observe/auto admission modes, Policy and Mandate versioning. |
| https://raw.githubusercontent.com/deepseek-ai/dsh-superagent-prototype/main/docs/003-execution.md | Current main | Ticket stages, worker Session and directory, role-specific presets, five-second shell promotion, 30-minute background cap, slot accounting, preparation, recovery, and review completion. |
| https://raw.githubusercontent.com/deepseek-ai/dsh-superagent-prototype/main/docs/004-prompts.md | Current main | Team-editable prompt sections and skills, base-tracked prompt overrides, precedence, and code-owned gates. |
| https://raw.githubusercontent.com/deepseek-ai/dsh-superagent-prototype/main/docs/005-panel.md | Current main | Human-first panel order: work needing a person, system health, then history; Overview, Source, Trigger, Eval, Execution, Settings. |
| https://raw.githubusercontent.com/deepseek-ai/dsh-superagent-prototype/main/docs/006-deployment.md | Current main | Dedicated profile and agent account, optional Feishu, separate router/worker presets, and warning that default workers run with full OS-user access. |
| https://raw.githubusercontent.com/deepseek-ai/dsh-superagent-prototype/main/docs/007-architecture.md | Current main | Transactional Engine, repositories, Policy, Assessor, Executor, Outbox, SourceRegistry, effects, and Runtime composition root. |
| https://raw.githubusercontent.com/deepseek-ai/dsh-superagent-prototype/main/docs/008-cookbook.md | Current main | Source extension contract: event translation, receiving/authorization rules, replies/context, and polling/cursors. |
| https://deepseek.com/en/harness/ | Current product page | Harness is open source, MIT, public preview, and plugin-composable. |
| https://api-docs.deepseek.com/guides/responses_api/ | Current API docs | Responses API support; function tools; web_search only with deepseek-v4-pro; JSON Schema output; parallel tool calls always enabled; stateless API; background, stored conversations, previous-response continuation, and built-in code interpreter/computer-use/MCP are unsupported or ignored. |
| https://api-docs.deepseek.com/api/create-response/ | Current API reference | Tool-name restrictions, function/custom/web-search forms, and structured-output fields. |
| https://api-docs.deepseek.com/guides/tool_calls/ | Current API docs | Thinking-mode tool use and requirement to replay complete reasoning content on subsequent requests. |
| https://api-docs.deepseek.com/guides/thinking_mode/ | Current API docs | Multiple reasoning/tool rounds and model-specific tool behavior. |
| https://api-docs.deepseek.com/guides/search/ | Current API docs | Raw read-only Search/Fetch APIs, structured results, query operators, errors, limits, and billing. |
| https://api-docs.deepseek.com/updates/ | Entries through 2026-10-17 | V4.1-Flash, V4-Pro, multimodal support, agent benchmark claims, Responses support, and the in-house Search API. |
| https://api-docs.deepseek.com/news/news260813/ | 2026-08-13 | V4-Pro agent-focused release, low/high/max thinking effort, Responses support, and vendor-reported benchmarks. |

## What the super-agent design adds

### Operating model

The prototype is a proactive, source-driven work manager, not a new model. Its durable concepts are:

- Source: event stream, cursor, identity, listening scope, trigger translation, context reads, and reply channel.
- Trigger: immutable source event, deduplicated by stable identity.
- Thread: source-defined conversation/issue/PR; one Eval at a time and multiple Tickets.
- Eval: bounded admission assessment that records ignore, unavailable, or accept decisions and reasons.
- Ticket: accepted work with a Mandate, subscriptions, assignments, Reports, Attentions, and an end outcome.
- Mandate: policy version, requester, source scope, matched rules, and execution restrictions captured at admission.
- Assignment and Executor: worker Session and directory that can resume, interrupt, retry, or hand off.
- Channel and Outbox: source-specific delivery with durable receipts and idempotent effects.

This answers when work should start, who authorized it, who owns a follow-up, what survives restart, and what needs a human.

### Authorization and attention

The design admits explicit human requests only from allowed senders and only when the message addresses the agent. Subscribed Thread messages reach a Ticket as context without automatically granting authority. Bots and CI can create inferred candidates but are not explicit requests. A follow-up stays with the Ticket that owns it; an out-of-scope message is handed back exactly once to main evaluation. Off disables inferred work, observe records what would be accepted without starting it, and auto accepts positive assessments. Policy version is captured in each Mandate; policy changes re-evaluate queued work and notify affected Tickets. Ordinary progress stays quiet; the agent speaks when a result, failure, question, or decision needs attention.

These are code-enforced governance rules, not prompt suggestions. The prototype keeps gates, Mandates, tool checks, and account wrappers outside editable prompt text.

### Execution and recovery

Each Ticket gets a worker Session and per-ticket checkout directory. The worker preset exposes execution tools; the router preset exposes fewer tools. Foreground shell commands become background jobs after five seconds so new inputs can arrive. A Ticket retains its worker slot while jobs or subagents run. Background work is capped after each turn, with killed jobs and remaining work reported. Preparation, source metadata, working directories, pull-request association, retry, interruption, and recovery are explicit. The deployment guide warns that the published worker runs as the OS user with full access, and that wrappers are defaults rather than a security boundary.

### Prompt and UI system

Teams edit Communication, Ticket scope, Delivery requirements, and skills. Built-in prompt parts have keys and base versions; upgrades preserve local overrides and show changed defaults. Code owns gates, tools, notices, and cards. The panel prioritizes work needing a person, then health, then trace history.

## Capability matrix against this checkout

| Capability | Prototype evidence | Existing repo seam | Fit and gap |
| --- | --- | --- | --- |
| Durable work items | Ticket, Assignment, Report, Attention | Session events/projections, Goal, Schedule | High fit, but no generic source-owned Ticket lifecycle. Goal is one objective; Schedule is future delivery. |
| Named peer agents | Executor Sessions and subagents | dsh-subagent, experimental Agent Teams, subagent-control | High fit. Team is flat, shared-checkout, one-process, and advisory; prototype needs isolated workspaces and Ticket metadata. |
| Task DAG | Dependencies and assignments | Team task board with CAS revisions, blocker DAG, write-scope warnings | High fit for coordination; do not overload Team with source/Mandate/Report semantics. |
| Source intake | GitHub and Feishu Source kinds | Webhook runtime, web service, plugin capability seams | Medium. A generic Source/Trigger/Channel contract and GitHub adapter are missing. |
| Admission policy | Explicit/inferred requests; off/observe/auto; policy version | Permission presets, approvals, agent events, goals | Medium-high. No durable Eval/Mandate service with sender/scope ownership. |
| Human handoff | Attention and blocked/review stages | Agent events, Goal activation, Session projections, Web client | High. First-class Report/Attention types and a panel projection are missing. |
| Background work | Shell promotion, jobs wake workers, slot limits | Jobs, shell/subprocess, subagent lifecycle | High. Ticket-level slot ownership and shutdown policy need a domain owner. |
| Per-workspace checkout | Ticket directory and preparation | Workspace paths, working-directory capture, shell/subprocess | Medium-high. Team intentionally shares one checkout; a coding Source needs owned worktrees. |
| Source outbox | Durable receipts and effects | Jobs/webhook runtime/effect patterns | Medium. No generic Channel/Outbox service. |
| Model orchestration | Worker subagents and prompt-defined scope | Workflow, subagent, Agent Teams | High. Workflow is foreground-only, has no journal/resume, and no token budget. |
| Research/web | Search/Fetch and server-side search | DeepSeek web-search and web API packages | Very high. The repo already has the required providers; raw Search/Fetch is the controlled low-cost route. |
| Structured output | Responses JSON Schema; subagent output schemas | LLM tool schemas and subagent outputSchema | High. Responses is stateless and has limited built-ins; translation must preserve durable history. |
| Multimodal agent | V4.1-Flash release claims | dsh-llm image content and image offload | Medium-high. Catalog and route capability declarations must match live models. |
| Long context | V4 release claims | Compaction, prompt assembly, token meter | Medium. Large context does not replace durable history; over-window Responses requests fail. |
| Safety | Explicit code gates and dedicated account | Sandbox, approvals, credentials, presets | High in principle. Full-access workers can bypass command wrappers via absolute paths. |
| Evaluation | Vendor agent benchmark claims | Snapshot/e2e/test-support | Medium. Need local traces for admission, restart, delivery, and handoff. |

## Repo-specific findings

The repository already has most lower-level mechanics: event-sourced Sessions; model-visible means logged; subagent activation ownership, cancellation, depth, cwd, output schemas, cold resume and result notices; Team roster, inbox, CAS task board, blocker DAG, projections and waits; Workflow parallel/pipeline orchestration; Jobs background output cursors and completion notices; Goal pause/resume/complete/block; Schedule delivery; DeepSeek Search/Fetch and native search providers; sandbox and permission seams.

The largest missing concept is proactive admission. No generic service currently owns Source event cursors, stable Trigger deduplication, single-thread Eval, inferred versus explicit strength, Policy versions, Mandates, or source-specific follow-up ownership. Agent pre-step hooks can rewrite or reject a claimed message, but they do not solve source admission.

The second missing concept is durable Assignment/Report/Attention lifecycle. Goals are intentionally one-session objectives. Team tasks are coordination records. Jobs are process-level work. A source-driven coding agent needs a record of Trigger, authorization, worker Session, checkout, last Report, human Attention, and restart outcome.

Team’s documented limitations make it unsuitable as the whole super-agent foundation: one process, one shared checkout, advisory write scopes, flat roster, no automatic owner release, and no send retry guarantee.

DeepSeek’s Responses API is a possible provider route, not a state store. It supports JSON Schema, function tools, custom apply_patch, and server web_search for V4-Pro. It is stateless; previous response, stored conversation, background execution, code interpreter, computer use, and MCP are unsupported or ignored; parallel tool calls are always enabled; over-window requests fail; thinking-mode calls require complete reasoning replay. The existing Session log should remain canonical.

The raw DeepSeek Search/Fetch APIs return structured ranked results, authority, summaries/content, read-only behavior, 100 QPS Search and 25 QPS Fetch account limits, and per-success billing. The official docs say server-side calls through Harness, Claude Code, or Codex become billable on 2026-11-01. This reinforces the value of the existing dedicated raw provider for controlled retrieval and cost accounting.

## Recommendations

### Adopt now

1. Treat dsh-superagent as a separate experimental product plugin. Keep Agent Loop, Team, Goal, Schedule, Workflow, and provider contracts intact.
2. Adopt the Source, Trigger, Thread, Eval, Ticket, Mandate vocabulary in a new experimental package with a durable Session projection.
3. Implement off, observe, and auto proactive admission. Record positive observe decisions without launching work.
4. Make stable Trigger IDs, source cursors, sender/scope checks, and Mandate snapshots code-enforced.
5. Reuse existing Jobs, Subagent, Workspace, Sandbox, and Session Projection seams for Executors.
6. Add a generic Report/Attention projection before building a broad UI. “Needs a human now” is the highest-value first view.
7. Keep Search/Fetch as the controlled retrieval path and update usage/billing documentation for the 2026-11-01 change.
8. Keep the existing sandbox/approval posture. A full-access worker should require a dedicated OS identity and make that choice visible.

### Prototype next

1. Build one GitHub Source for Issues, PR comments, and CI, with stable cursors, allowlists, and idempotent delivery.
2. Add Ticket lifecycle events and projection for queued, working, waiting, ready, blocked, failed, and ended.
3. Allocate one owned worktree per Ticket with preparation and cleanup.
4. Build one idempotent Source Outbox with receipts, retry/backoff, and final-delivery deduplication.
5. Compose router and worker presets; keep router tools read-oriented and worker tools scoped to the Ticket.
6. Reuse Jobs for background execution but make Ticket ownership explicit across jobs, subagents, and shutdown.
7. Prototype a feature-gated Responses adapter only after recording stateless-history, reasoning replay, parallel-tool, JSON Schema, and custom apply_patch translation rules.
8. Exercise duplicate delivery, observe mode, policy change, worker crash/restart, follow-up ownership, failed source delivery, review wake-up, and worktree cleanup with deterministic fixtures.

### Defer

1. Do not copy the prototype’s whole SQLite Engine; it would create a second authority beside Session events and projections.
2. Defer Feishu and multiple Source kinds until the GitHub Source contract is stable.
3. Defer auto-merge; keep branch protection and human review authoritative.
4. Do not make authorization or safety prompt-editable.
5. Defer nested super-agent Teams; independent Tickets with isolated workspaces are the first value.
6. Do not treat a 1M context claim as a memory system; retain compaction, projections, and restart recovery.
7. Do not accept vendor benchmark scores as product acceptance evidence.

## Validation plan

A minimal prototype should prove:

1. Duplicate Trigger delivery creates exactly one Eval, Ticket, and Assignment.
2. Observe records a positive candidate without launching a worker; auto launches it.
3. Mandate records Policy version, sender, source scope, matched rules, and directory; later prompt edits do not mutate it.
4. Subscribed Thread messages reach the owning Ticket as context; out-of-scope follow-ups are handed back once and then evaluated normally.
5. Worker crash/restart recovers safely or ends explicitly without duplicate replies.
6. A long shell command becomes a background job, keeps the Ticket working, wakes the Executor, and is cancelled on Assignment end.
7. Source delivery retries with an idempotent receipt key and never duplicates the final reply.
8. Human review/answer creates an Attention projection and wakes the correct Ticket.
9. Worktree cleanup and overlapping-write diagnostics occur before two writers proceed.
10. A Responses fixture round trips tools, reasoning content, JSON Schema, and stateless replay through the Session log.

Verify both durable projection and model-visible transcript. For an implementation, run focused tests, then pnpm run build:artifacts followed by pnpm run build:check; run doc-sync only when maintained documentation or an Agent Note changes.

## Uncertainties and limits

- The prototype says it is adapted for publication and not identical to the internal system or referenced paper.
- Public source does not prove production reliability, scale, or human-attention outcomes.
- DeepSeek benchmark numbers and agent-capability claims are vendor-reported.
- API model names, pricing, limits, and Responses support may change before implementation.
- The phrase “new super agent” could refer to a model release or third-party product, but dsh-superagent is the only first-party artifact matching the phrase and this repository’s architecture.
- Verify current account pricing before relying on the Search/Fetch billing transition.

## Assessment

The beneficial part is the operating system for proactive work: explicit admission, stable event identity, Mandates, Ticket ownership, per-work-item execution, source outbox delivery, quiet progress, and a human-first supervision view. This repository already has the lower-level agent, session, team, goal, workflow, jobs, web, sandbox, and projection machinery. The next step should be an experimental source-driven Ticket plugin that composes those seams and proves restart, authorization, delivery, and attention behavior with deterministic traces. The prototype’s unrestricted worker defaults and private-store architecture should not become the foundation.



## Checkout-specific convergence

This checkout already contains the ingredients of the prototype, but they are intentionally separated by authority. `@deepseek-ai/dsh-webhook` and `@deepseek-ai/dsh-webhook-github` provide authenticated ingress and fire-and-forget Session creation; their documented limits are exactly the prototype's first missing layer: no replay queue, no deduplication, no completion state, and no durable delivery record. The proposed [event-triggered automation tasks](../notes/proposed/feature/2026-10-29-event-triggered-automation-tasks.md) is the closest in-repo design match. It already defines source providers, change detection, per-task state, merge windows, filtered/failed run records, read-only event turns, and action-card approval before edits or outbound messages.

The existing package boundaries suggest this composition rather than a second super-agent runtime:

| Super-agent concern | Existing owner to reuse | Missing layer |
| --- | --- | --- |
| Authenticated ingress | `dsh-webhook`, `dsh-webhook-github` | Durable delivery journal, deduplication, replay, and source cursors |
| Source status and PR lifecycle | `dsh-experimental-forge`, `dsh-experimental-forge-session` | A source-provider adapter that emits change candidates into automation |
| Time and delayed delivery | `dsh-schedule` | Convert time into the same source-provider vocabulary |
| Change filtering and merge windows | Proposed event-triggered automation task domain | Shared trigger state and bounded run records |
| Safe evaluation of external content | `dsh-session`, read-only event-turn preset, `dsh-action-cards` | Event-turn tool set and an automation-notify card kind |
| Long-running objective | `dsh-goal` and `dsh-goal-round-driver` | Do not make Goal own external source admission or per-event execution |
| Peer work | `dsh-experimental-agent-team`, `dsh-subagent`, `dsh-workflow` | Ticket-scoped ownership and worktree policy when autonomous execution is enabled |
| Retained participants and trusted effects | `dsh-experimental-fusion-participants` | A product owner that maps a Ticket to Fusion grants and runs |
| Workspace and code-review state | `dsh-workspace`, `dsh-working-directory`, `dsh-experimental-forge-session` | One owned worktree per autonomous Ticket, with cleanup and overlap diagnostics |
| Durable state and browser view | Session events plus `dsh-session-projection` | Ticket/Assignment/Attention projection and a human-first supervision view |
| Background execution | `dsh-jobs`, shell/subprocess, subagent lifecycle | Ticket-level slot accounting and stop/restart reconciliation |

The proposed automation note is safer than the published prototype for untrusted GitHub or chat content: the event turn has no shell, writes, web fetch, or MCP, and a user accepts an action card before the handling Session gets normal permissions. The prototype's `auto` mode and full-access worker are useful only as an explicitly opt-in second tier for trusted sources, dedicated identities, and code-owned policy.

## Recommended layering

A coherent implementation path is:

1. Keep `WebhookRuntime` as the authentication and normalization boundary. Add a durable source journal above it; do not put polling, authorization, Tickets, or user policy inside provider adapters.
2. Promote the proposed automation trigger layer into shared infrastructure. Give every observation a stable source identity, a source cursor/state revision, a deterministic change key, a filter result, and a bounded run record. Use one queue per task or source subject so retries cannot reorder decisions.
3. Implement event turns and `automation_notify` first. This gives the repository the largest user-value part of the prototype — low-noise proactive attention — while preserving the existing model-visible/logged rule and the action-card approval boundary.
4. Add autonomous Tickets only for a separate experimental profile. A Ticket should reference the source event, immutable admission facts, a policy revision, a target Session, a workspace/worktree, and an Assignment projection. Use existing Session events as the durable authority and keep the domain projection read-only.
5. Let a Ticket use Team, Subagent, Workflow, Jobs, and Fusion as internal mechanisms. None of those packages should become the source-event authority or absorb source-specific policy.
6. Add GitHub first by composing `webhook-github` for ingress and `forge`/`forge-session` for live PR state. Feishu, mail, and IM should wait until the event-provider contract has deterministic restart and dedup traces.

The first implementation should not add a new model protocol. The existing DeepSeek Messages adapter already records tool calls and reasoning replay, supports the current V4 catalog and large context metadata, and has tests for parallel tool results and signed thinking replay. DeepSeek's Responses API should be a separate adapter experiment only if a concrete capability requires it; its current documentation describes a stateless interface and a narrower built-in tool surface than the Session log already supplies.

## Review caveat from this checkout

The public prototype passes its own typecheck, 1,197 tests, and build at commit `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`. The current checkout's focused webhook/team/Fusion test command is not green at the review head: 49 files ran, 39 passed, 10 failed, with 59 failed tests out of 808. Failures cluster in Fusion retained-writer cleanup, durability, and teardown timing, including several five-second timeouts. These failures were observed without modifying the reviewed source; unrelated local edits appeared while the command ran and were preserved. Treat the current Fusion branch as an active implementation baseline until those tests are reconciled.
