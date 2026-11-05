# Factory Missions and Workstreams: implications for Ticket and Job

English | [中文](factory-missions-workstreams.zh.md)

Research date: 2026-11-04

This note compares the public Factory documentation for Missions and Workstreams with the repository's current experimental Ticket and Jobs contracts. Factory claims below link to first-party Factory documentation or Factory's own architecture article. The comparison is an architectural recommendation, not a claim that DSH should reproduce Factory.

## Local baseline

Ticket is a durable, Session-backed record for one piece of work. It owns a ticket lifecycle, direct worker assignments, execution-slot declarations, work scopes, reports, questions, attention items, coordinator handoff, compare-and-set revisions, and terminal outcomes. Its README explicitly keeps the domain independent of Fusion, Agent Teams, Worktree, Jobs, UI, polling, and generic subagent spawning; the execution adapter composes Ticket with Jobs and Worktree providers while Ticket remains the durable authority. See [`packages/experimental/ticket/README.md`](../../packages/experimental/ticket/README.md), [`types.ts`](../../packages/experimental/ticket/src/types.ts), and [`execution.ts`](../../packages/experimental/ticket/src/execution.ts).

Job is a process-local supervised execution registry. A Job has an owner Session/Agent, bounded output retention and model-facing reads, cancellation/settlement hooks, and log-only registration/settlement events. The local provider keeps live state and output rings in memory and disposes jobs with the owning Agent or service. See [`packages/jobs/jobs/src/types.ts`](../../packages/jobs/jobs/src/types.ts) and [`packages/jobs/jobs-local/src/index.ts`](../../packages/jobs/jobs-local/src/index.ts).

## Distinct Factory capabilities

### Missions

- **Upfront collaborative planning.** A user and Droid iterate until requirements and constraints are clear; Missions then build a structured plan of features grouped into milestones. The docs call this a planning conversation rather than a one-shot prompt. [Factory Missions overview](https://docs.factory.com/missions/overview#how-it-works), [Planning & Validation](https://docs.factory.com/missions/planning#the-planning-phase-matters-most).
- **Feature/milestone decomposition.** A feature is a bounded implementation unit; milestones are meaningful checkpoints that organize features and determine validation frequency. [Factory Missions overview](https://docs.factory.com/missions/overview#how-it-works), [Planning & Validation](https://docs.factory.com/missions/planning#validation).
- **Mission-level validation contract.** The orchestrator defines a finite checklist of testable behavioral assertions before defining features; fresh agents later exercise the application as a black box against that contract. [How Missions Work](https://factory.com/news/missions-architecture#the-system), [How Missions Work](https://factory.com/news/missions-architecture#test-driven-development-at-two-levels).
- **Separate roles and incentives.** The orchestrator plans/steers, workers implement bounded features, and independent validators assess correctness; validators report gaps rather than fixing them, and the orchestrator creates fix features. [How Missions Work](https://factory.com/news/missions-architecture#separation-of-concerns-and-incentives).
- **Fresh-context workers and externalized shared state.** Missions use fresh agents with narrow goals and shared artifacts such as validation contracts, feature lists, research notes, operational guidance, and a knowledge base. [How Missions Work](https://factory.com/news/missions-architecture#externalized-state), [How Missions Work](https://factory.com/news/missions-architecture#the-system).
- **Milestone revalidation and recovery loop.** After a milestone's features finish, scrutiny and user-testing validators run; failures become targeted fix features, followed by revalidation. If implementation or validation is blocked, the mission halts and returns control to the user. [How Missions Work](https://factory.com/news/missions-architecture#the-system).
- **Mission Control and resumability.** The App exposes progress, milestones, worker details, validation criteria, commits, model choices, pause/re-plan, and resumption of past missions. [Running in the Factory App](https://docs.factory.com/missions/running-app#the-mission-control-dashboard), [Running in the Factory App](https://docs.factory.com/missions/running-app#starting-and-resuming-missions).
- **Config inheritance and headless operation.** Missions inherit MCP integrations, skills, hooks, custom droids, and AGENTS.md. They can run headlessly via `droid exec --mission`; worker and validator models/reasoning can be configured separately. [Missions Configuration & Reference](https://docs.factory.com/missions/reference#configuration-inheritance), [Missions Configuration & Reference](https://docs.factory.com/missions/reference#headless-mission-execution).
- **Scriptable QA as a readiness requirement.** Factory says Missions need a reliable, scriptable way to start, drive, and observe the application for user-facing QA; without it, self-validation is unreliable. [Factory Missions overview](https://docs.factory.com/missions/overview#for-optimal-outcomes), [Planning & Validation](https://docs.factory.com/missions/planning#development-scripting-for-qa).

### Workstreams

- **Persistent orchestrator-led coordination.** A Workstream is intended for work spanning days or weeks. An orchestrator splits the goal into areas, starts agents, coordinates them in parallel, and keeps accepting new tasks in the same Workstream. [Workstreams overview](https://docs.factory.com/workstreams/overview#workstreams), [Workstreams overview](https://docs.factory.com/workstreams/overview#when-to-use-a-workstream).
- **Conversation-first, adaptive decomposition.** Unlike Missions' upfront feature/milestone plan, a Workstream starts with a conversation and the orchestrator delegates as work unfolds. [Workstreams overview](https://docs.factory.com/workstreams/overview#when-to-use-a-workstream).
- **Agent roles and direct access.** The orchestrator is the lead session; each agent owns one area, reports progress/blockers/results, can open pull requests, and can be opened for direct conversation. [Workstreams overview](https://docs.factory.com/workstreams/overview#how-a-workstream-is-organized), [Workstreams overview](https://docs.factory.com/workstreams/overview#how-it-works).
- **Shared folder for durable cross-agent artifacts.** Every Workstream has a synchronized folder for plans, notes, findings, handoffs, reports, and deliverables; code remains in the repository and is delivered through pull requests. [Workstream Shared Folder](https://docs.factory.com/workstreams/shared-folder#workstream-shared-folder).
- **Machine placement and isolation choices.** Orchestrator/agents may run on fresh environment computers, Droid Computers, or the local computer. Environment computers give each agent an isolated fresh machine; local agents share the selected directory; worktrees can be selected for local/existing computers. [Workstream Machines](https://docs.factory.com/workstreams/machines#machine-types), [Workstream Machines](https://docs.factory.com/workstreams/machines#choose-the-orchestrator-machine).
- **Remote delegation and machine routing.** Defaults can allow agents on other environments/machines; machine descriptions guide routing. [Workstream Machines](https://docs.factory.com/workstreams/machines#choose-where-agents-run), [Workstream Settings and Usage](https://docs.factory.com/workstreams/settings#workstream-defaults).
- **Human intervention states.** Agents can appear as Waiting on you, Working, or Idle; questions/approvals surface to the human, who can message the orchestrator or agent. [Workstreams overview](https://docs.factory.com/workstreams/overview#how-it-works), [Workstreams Quickstart](https://docs.factory.com/workstreams/quickstart#step-3-follow-the-agents).
- **PR-centric review surface.** Workstreams track every PR opened or worked on, checks, review activity, and agent ownership in a PRs tab. [Workstream Pull Requests](https://docs.factory.com/workstreams/pull-requests#workstream-pull-requests).
- **Model, reasoning, usage, and autonomy controls.** Workstream settings choose orchestrator/agent models and reasoning; usage is tracked by session; remote delegation, compaction budget, and machine defaults are configurable; autonomy remains policy-capped. [Workstream Settings and Usage](https://docs.factory.com/workstreams/settings#workstream-settings), [Workstream Settings and Usage](https://docs.factory.com/workstreams/settings#workstream-defaults).
- **Beta/availability caveat.** The public overview labels Workstreams beta and says availability is currently Pro/Plus/Max/Teams, not Business/Enterprise. [Workstreams overview](https://docs.factory.com/workstreams/overview#workstreams).

## Comparison to DSH

| Factory idea | Closest DSH concept | Fit and gap |
| --- | --- | --- |
| Mission plan, features, milestones | Ticket subject/description, assignments, statuses | Ticket has durable assignment/lifecycle primitives, but no first-class plan graph, feature-to-milestone grouping, or pre-execution approval phase. |
| Validation contract and independent validators | Ticket reports, reviewer/integrator roles, terminal outcome | Ticket can record reports and reviewer assignments, but does not model immutable behavioral assertions, validator runs, or automatic fix/revalidate loops. |
| Workstream orchestrator and direct agents | Ticket coordinator plus direct worker Assignments | Strong conceptual fit: Ticket already names a coordinator, direct Session owners, CAS revisions, reports, questions, attention, and handoff. Factory's ongoing stream is broader than one Ticket rooted in one Session. |
| Waiting on you / blockers / decisions | Ticket questions, attention, blocked status | Strong vocabulary overlap. Ticket is already the durable record; Factory's UI state is a presentation/interaction layer absent from Ticket. |
| Shared folder and knowledge artifacts | Ticket reports/evidence/next steps; repository and Session storage | Partial fit. Ticket retains bounded reports and evidence, not a synchronized artifact workspace or evolving knowledge library. |
| Machines, environments, worktrees | Ticket WorkScope and ExecutionSlotMode; Worktree adapter | Partial fit. DSH declares shared/isolated/dedicated execution modes and delegates live workspace creation to adapters; Factory adds multi-machine routing and fresh-machine isolation. |
| Jobs / live execution | DSH Job registry | Jobs are the right analogue for process-local execution, output rings, cancellation, ownership, and settlement. Factory Workstream/Mission is an orchestration/product layer above such executions, not a replacement for Job semantics. |
| PR-centric delivery | Ticket result/report and future adapters | Factory treats PRs as a first-class review artifact. Ticket currently records reports and terminal outcomes; PR identity/status would be an adapter or separate durable projection unless the product explicitly makes PRs part of Ticket's domain. |
| Mission Control / Workstream UI | Ticket projection + browser/UI consumers | DSH has a browser-safe Ticket projection but no supervision UI. Adding a UI is a consumer concern; do not make Ticket depend on UI state. |
| Separate model roles | Worker Assignment role and Job kind | Ticket already has worker/reviewer/integrator/observer roles; model selection and reasoning are not currently durable Ticket fields. This is orchestration policy, not a required Ticket invariant. |

## Adoption ranking

### Adopt

1. **Durable, explicit questions/attention/blockers and coordinator handoff.** Ticket already has these primitives; keep treating them as the durable coordination surface. Factory confirms these are necessary human-intervention states for long-running delegation, while the current Ticket design can represent them without introducing Fusion concepts. [Workstreams overview](https://docs.factory.com/workstreams/overview#how-it-works).
2. **Independent validation as a separate Assignment role.** Add validator behavior through an adapter or assignment policy that records validation evidence and findings as Ticket reports. The Factory role separation is directly compatible with Ticket's reviewer/integrator roles and avoids making workers the sole judge of their own output. [How Missions Work](https://factory.com/news/missions-architecture#separation-of-concerns-and-incentives).
3. **Explicit validation criteria attached to a bounded effort.** Consider a Ticket-owned, bounded validation checklist only if a concrete consumer needs it; model assertions/evidence as durable data, while keeping execution and QA tools in adapters. Factory's validation-contract ordering is a useful invariant. [How Missions Work](https://factory.com/news/missions-architecture#test-driven-development-at-two-levels).
4. **Externalized artifacts through a separate shared-artifact capability.** Preserve Ticket's bounded reports and evidence, but consider a separate artifact/notes provider for larger plans, findings, and handoffs. Factory puts these in a synchronized shared folder rather than overloading the work item record. [Workstream Shared Folder](https://docs.factory.com/workstreams/shared-folder#what-goes-in-the-shared-folder).

### Adapt

1. **Features and milestones as an optional planning projection.** Factory's decomposition is useful for large bounded efforts, but adding a plan graph directly to Ticket would widen its domain. Prefer a separate Mission/plan service that references Ticket IDs or assignments and emits durable summaries. [Factory Missions overview](https://docs.factory.com/missions/overview#build-features-and-milestones).
2. **Machine placement and fresh-worker isolation.** Extend the execution adapter's slot/worktree metadata only where DSH needs remote machines or per-worker isolation. Keep live machine leases and process state provider-owned, as Jobs and Worktree already are. [Workstream Machines](https://docs.factory.com/workstreams/machines#machine-types).
3. **PR linkage.** Add PR references to an adapter/projection when repository workflows require them; do not make PR lifecycle a core Ticket status unless the product explicitly defines that coupling. [Workstream Pull Requests](https://docs.factory.com/workstreams/pull-requests#the-prs-tab).
4. **Mission Control-like monitoring.** Build a UI over Ticket projections and Job views if needed. Do not store UI-only progress logs or model-selection controls in Ticket. [Running in the Factory App](https://docs.factory.com/missions/running-app#the-mission-control-dashboard).

### Defer

1. **Full Factory Mission runner.** Upfront planning, feature scheduling, independent validators, automatic fix features, and milestone retries are a complete orchestration product. They are larger than Ticket's durable coordination responsibility and would pull Fusion concerns into the domain. [How Missions Work](https://factory.com/news/missions-architecture#the-system).
2. **Full Workstream product semantics.** Persistent multi-ticket streams, synchronized shared folders, multi-machine routing, PR dashboards, and ongoing task intake should remain a higher-level orchestration/workspace capability. The public docs do not establish a need to fold them into Ticket. [Workstreams overview](https://docs.factory.com/workstreams/overview#when-to-use-a-workstream), [Workstream Machines](https://docs.factory.com/workstreams/machines#choose-where-agents-run).
3. **Factory-specific quotas, plans, or UI availability rules.** These are product/service concerns; Workstreams' beta and plan availability are explicitly Factory-specific and not evidence for DSH domain behavior. [Workstreams overview](https://docs.factory.com/workstreams/overview#workstreams).
4. **Assuming hidden implementation details.** Public docs do not specify Mission/Workstream wire schemas, persistence formats, retry algorithms, worker identity protocols, or exact conflict-resolution semantics. Treat those as absent/uncertain rather than importing names or data models.

## Uncertainty and absence

The public Factory documentation establishes product behavior and architectural principles, but it does **not** publish a complete Mission or Workstream data model/API. In particular, it is uncertain whether every listed UI state is durably persisted, how worker identity is encoded, how conflicts are resolved beyond the stated coordination behavior, and whether shared-folder history is event-sourced. No public source reviewed here documents a Ticket-like compare-and-set revision protocol, a Job-like output-ring contract, or a stable cross-surface wire schema. Those concepts should not be inferred from the UI descriptions.

## Sources

Primary sources reviewed:

- https://docs.factory.com/missions/overview
- https://docs.factory.com/missions/planning
- https://docs.factory.com/missions/reference
- https://docs.factory.com/missions/running-app
- https://factory.com/news/missions-architecture
- https://docs.factory.com/workstreams/overview
- https://docs.factory.com/workstreams/quickstart
- https://docs.factory.com/workstreams/machines
- https://docs.factory.com/workstreams/shared-folder
- https://docs.factory.com/workstreams/pull-requests
- https://docs.factory.com/workstreams/settings
