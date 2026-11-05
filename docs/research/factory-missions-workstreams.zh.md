# Factory Missions 与 Workstreams：对 Ticket 和 Job 的启示

[English](factory-missions-workstreams.md) | 中文

调研日期：2026-11-04

本文将 Factory 公开的 Missions 与 Workstreams 文档，同本仓库当前实验性的 Ticket 与 Jobs 约定进行对比。下文关于 Factory 的论断均链接到 Factory 官方文档或其自家的架构文章。这一对比是架构层面的建议，并不主张 DSH 应复刻 Factory。

## 本地基线

Ticket 是以 Session 为后盾、记录一项工作的持久化记录。它拥有 Ticket 生命周期、直接 Worker 分配、执行槽位声明、工作范围、报告、问题、关注项、协调者交接、比较并交换（compare-and-set）版本以及终态结果。其 README 明确要求该领域独立于 Fusion、Agent Teams、Worktree、Jobs、UI、轮询和通用 subagent 创建；执行适配器把 Ticket 与 Jobs 和 Worktree 提供方组合起来，而 Ticket 始终是持久化权威。参见 [`packages/experimental/ticket/README.zh.md`](../../packages/experimental/ticket/README.zh.md)、[`types.ts`](../../packages/experimental/ticket/src/types.ts) 和 [`execution.ts`](../../packages/experimental/ticket/src/execution.ts)。

Job 是进程内受监督的执行注册表。一个 Job 有所属的 Session/Agent、有界的输出保留和面向模型的读取、取消与结算钩子，以及仅写日志的注册与结算事件。本地提供方把实时状态和输出环保存在内存中，并随所属 Agent 或服务一同释放 Job。参见 [`packages/jobs/jobs/src/types.ts`](../../packages/jobs/jobs/src/types.ts) 和 [`packages/jobs/jobs-local/src/index.ts`](../../packages/jobs/jobs-local/src/index.ts)。

## Factory 的独有能力

### Missions

- **前期协作式规划。** 用户与 Droid 反复迭代，直到需求和约束明确；随后 Missions 构建按里程碑分组的结构化功能计划。文档称其为规划对话，而非一次性提示词。[Factory Missions overview](https://docs.factory.com/missions/overview#how-it-works)、[Planning & Validation](https://docs.factory.com/missions/planning#the-planning-phase-matters-most)。
- **功能与里程碑分解。** 功能是有界的实现单元；里程碑是有意义的检查点，用来组织功能并决定验证频率。[Factory Missions overview](https://docs.factory.com/missions/overview#how-it-works)、[Planning & Validation](https://docs.factory.com/missions/planning#validation)。
- **Mission 级验证约定。** 编排者在定义功能之前先定义一份有限的、可测试的行为断言清单；之后由全新的 agent 以黑盒方式对照该约定操作应用。[How Missions Work](https://factory.com/news/missions-architecture#the-system)、[How Missions Work](https://factory.com/news/missions-architecture#test-driven-development-at-two-levels)。
- **角色与激励分离。** 编排者负责规划与引导，Worker 实现有界功能，独立验证者评估正确性；验证者只报告缺口而不修复，由编排者创建修复功能。[How Missions Work](https://factory.com/news/missions-architecture#separation-of-concerns-and-incentives)。
- **全新上下文的 Worker 与外置共享状态。** Missions 使用目标狭窄的全新 agent，并通过共享产物协作，例如验证约定、功能清单、调研笔记、操作指引和知识库。[How Missions Work](https://factory.com/news/missions-architecture#externalized-state)、[How Missions Work](https://factory.com/news/missions-architecture#the-system)。
- **里程碑重新验证与恢复循环。** 一个里程碑的功能完成后，运行审查（scrutiny）与用户测试验证者；失败转为针对性的修复功能，随后重新验证。若实现或验证受阻，Mission 暂停并把控制权交还用户。[How Missions Work](https://factory.com/news/missions-architecture#the-system)。
- **Mission Control 与可恢复性。** App 展示进度、里程碑、Worker 详情、验证标准、提交、模型选择、暂停与重新规划，并支持恢复过往的 Mission。[Running in the Factory App](https://docs.factory.com/missions/running-app#the-mission-control-dashboard)、[Running in the Factory App](https://docs.factory.com/missions/running-app#starting-and-resuming-missions)。
- **配置继承与无头运行。** Missions 继承 MCP 集成、skill、钩子、自定义 droid 和 AGENTS.md。它们可通过 `droid exec --mission` 无头运行；Worker 与验证者的模型和推理强度可分别配置。[Missions Configuration & Reference](https://docs.factory.com/missions/reference#configuration-inheritance)、[Missions Configuration & Reference](https://docs.factory.com/missions/reference#headless-mission-execution)。
- **可脚本化 QA 是就绪前提。** Factory 指出，Missions 需要一种可靠、可脚本化的方式来启动、驱动并观察应用以完成面向用户的 QA；没有它，自我验证不可靠。[Factory Missions overview](https://docs.factory.com/missions/overview#for-optimal-outcomes)、[Planning & Validation](https://docs.factory.com/missions/planning#development-scripting-for-qa)。

### Workstreams

- **持久的、由编排者主导的协调。** Workstream 面向持续数天或数周的工作。编排者把目标拆分为多个领域，启动 agent，并行协调它们，并在同一个 Workstream 中持续接收新任务。[Workstreams overview](https://docs.factory.com/workstreams/overview#workstreams)、[Workstreams overview](https://docs.factory.com/workstreams/overview#when-to-use-a-workstream)。
- **对话优先、自适应的分解。** 与 Missions 前期制定功能与里程碑计划不同，Workstream 从一次对话开始，编排者随工作展开逐步委派。[Workstreams overview](https://docs.factory.com/workstreams/overview#when-to-use-a-workstream)。
- **Agent 角色与直接访问。** 编排者是主导会话；每个 agent 负责一个领域，汇报进度、阻塞和结果，可以打开 Pull Request，也可以被打开进行直接对话。[Workstreams overview](https://docs.factory.com/workstreams/overview#how-a-workstream-is-organized)、[Workstreams overview](https://docs.factory.com/workstreams/overview#how-it-works)。
- **跨 agent 持久产物的共享文件夹。** 每个 Workstream 都有一个同步文件夹，存放计划、笔记、发现、交接、报告和交付物；代码仍留在仓库中，通过 Pull Request 交付。[Workstream Shared Folder](https://docs.factory.com/workstreams/shared-folder#workstream-shared-folder)。
- **机器放置与隔离选择。** 编排者和 agent 可运行在全新的环境计算机、Droid Computer 或本地计算机上。环境计算机为每个 agent 提供隔离的全新机器；本地 agent 共享所选目录；本地或现有计算机可选用 worktree。[Workstream Machines](https://docs.factory.com/workstreams/machines#machine-types)、[Workstream Machines](https://docs.factory.com/workstreams/machines#choose-the-orchestrator-machine)。
- **远程委派与机器路由。** 默认设置可允许 agent 运行在其他环境或机器上；机器描述用于引导路由。[Workstream Machines](https://docs.factory.com/workstreams/machines#choose-where-agents-run)、[Workstream Settings and Usage](https://docs.factory.com/workstreams/settings#workstream-defaults)。
- **人工介入状态。** Agent 可显示为 Waiting on you、Working 或 Idle；问题和审批会呈现给人，人可向编排者或 agent 发送消息。[Workstreams overview](https://docs.factory.com/workstreams/overview#how-it-works)、[Workstreams Quickstart](https://docs.factory.com/workstreams/quickstart#step-3-follow-the-agents)。
- **以 PR 为中心的评审界面。** Workstream 在 PRs 标签页中跟踪每个已打开或处理过的 PR、检查结果、评审活动和 agent 归属。[Workstream Pull Requests](https://docs.factory.com/workstreams/pull-requests#workstream-pull-requests)。
- **模型、推理、用量和自主性控制。** Workstream 设置选择编排者和 agent 的模型与推理强度；用量按会话跟踪；远程委派、压缩预算和机器默认值可配置；自主性仍受策略上限约束。[Workstream Settings and Usage](https://docs.factory.com/workstreams/settings#workstream-settings)、[Workstream Settings and Usage](https://docs.factory.com/workstreams/settings#workstream-defaults)。
- **Beta 与可用性提示。** 公开概览把 Workstreams 标为 beta，并称目前面向 Pro/Plus/Max/Teams，不含 Business/Enterprise。[Workstreams overview](https://docs.factory.com/workstreams/overview#workstreams)。

## 与 DSH 的对比

| Factory 理念 | 最接近的 DSH 概念 | 契合与缺口 |
| --- | --- | --- |
| Mission plan, features, milestones | Ticket subject/description, assignments, statuses | Ticket 有持久化的分配与生命周期原语，但没有一等的计划图、功能到里程碑的分组，也没有执行前的审批阶段。 |
| Validation contract and independent validators | Ticket reports, reviewer/integrator roles, terminal outcome | Ticket 可以记录报告和评审者分配，但不对不可变的行为断言、验证者运行或自动的修复与重新验证循环建模。 |
| Workstream orchestrator and direct agents | Ticket coordinator plus direct worker Assignments | 概念上高度契合：Ticket 已经具备协调者、直接 Session 所有者、CAS 版本、报告、问题、关注项和交接。Factory 的持续流比根植于单个 Session 的单个 Ticket 更宽。 |
| Waiting on you / blockers / decisions | Ticket questions, attention, blocked status | 词汇高度重合。Ticket 已是持久化记录；Factory 的 UI 状态属于展示与交互层，Ticket 中没有这一层。 |
| Shared folder and knowledge artifacts | Ticket reports/evidence/next steps; repository and Session storage | 部分契合。Ticket 保留有界的报告和证据，但不是同步的产物工作区，也不是不断演进的知识库。 |
| Machines, environments, worktrees | Ticket WorkScope and ExecutionSlotMode; Worktree adapter | 部分契合。DSH 声明共享、隔离、专用的执行模式，并把实时工作区的创建交给适配器；Factory 另增多机器路由和全新机器隔离。 |
| Jobs / live execution | DSH Job registry | Job 是进程内执行、输出环、取消、所有权和结算的合适对应物。Factory 的 Workstream/Mission 是位于这类执行之上的编排与产品层，而不是 Job 语义的替代品。 |
| PR-centric delivery | Ticket result/report and future adapters | Factory 把 PR 视为一等评审产物。Ticket 目前记录报告和终态结果；除非产品明确把 PR 纳入 Ticket 领域，否则 PR 标识与状态应由适配器或单独的持久化投影承担。 |
| Mission Control / Workstream UI | Ticket projection + browser/UI consumers | DSH 有浏览器安全的 Ticket 投影，但没有监督 UI。增加 UI 是消费方的事；不要让 Ticket 依赖 UI 状态。 |
| Separate model roles | Worker Assignment role and Job kind | Ticket 已有 worker/reviewer/integrator/observer 角色；模型选择和推理强度目前不是持久化的 Ticket 字段。这属于编排策略，而非 Ticket 必需的不变量。 |

## 采纳排序

### 采纳

1. **持久化的显式问题、关注项、阻塞以及协调者交接。** Ticket 已具备这些原语；应继续把它们当作持久化的协调界面。Factory 印证了这些是长时间委派所必需的人工介入状态，而当前 Ticket 设计无需引入 Fusion 概念即可表达它们。[Workstreams overview](https://docs.factory.com/workstreams/overview#how-it-works)。
2. **把独立验证作为单独的 Assignment 角色。** 通过适配器或分配策略加入验证者行为，把验证证据和发现记录为 Ticket 报告。Factory 的角色分离与 Ticket 的 reviewer/integrator 角色直接兼容，并避免让 Worker 成为自身产出的唯一裁判。[How Missions Work](https://factory.com/news/missions-architecture#separation-of-concerns-and-incentives)。
3. **把明确的验证标准附加到有界的工作上。** 仅当有具体消费方需要时，才考虑由 Ticket 拥有一份有界的验证清单；断言和证据按持久化数据建模，执行与 QA 工具留在适配器中。Factory 先定义验证约定的顺序是有用的不变量。[How Missions Work](https://factory.com/news/missions-architecture#test-driven-development-at-two-levels)。
4. **通过独立的共享产物能力外置产物。** 保留 Ticket 有界的报告和证据，但对较大的计划、发现和交接，可考虑单独的产物/笔记提供方。Factory 把这些放在同步的共享文件夹中，而不是让工作项记录承担过多职责。[Workstream Shared Folder](https://docs.factory.com/workstreams/shared-folder#what-goes-in-the-shared-folder)。

### 调整后采纳

1. **把功能与里程碑作为可选的规划投影。** Factory 的分解对大型有界工作有用，但直接在 Ticket 中加入计划图会扩大其领域。更好的做法是由单独的 Mission/计划服务引用 Ticket ID 或分配，并产出持久化摘要。[Factory Missions overview](https://docs.factory.com/missions/overview#build-features-and-milestones)。
2. **机器放置与全新 Worker 隔离。** 仅在 DSH 需要远程机器或按 Worker 隔离时，才扩展执行适配器的槽位/worktree 元数据。实时机器租约和进程状态仍归提供方所有，Jobs 和 Worktree 已是如此。[Workstream Machines](https://docs.factory.com/workstreams/machines#machine-types)。
3. **PR 关联。** 当仓库工作流需要时，把 PR 引用加入适配器或投影；除非产品明确定义这种耦合，否则不要让 PR 生命周期成为 Ticket 的核心状态。[Workstream Pull Requests](https://docs.factory.com/workstreams/pull-requests#the-prs-tab)。
4. **类 Mission Control 的监控。** 如有需要，在 Ticket 投影和 Job 视图之上构建 UI。不要在 Ticket 中保存仅用于 UI 的进度日志或模型选择控件。[Running in the Factory App](https://docs.factory.com/missions/running-app#the-mission-control-dashboard)。

### 推迟

1. **完整的 Factory Mission 运行器。** 前期规划、功能调度、独立验证者、自动修复功能和里程碑重试构成一个完整的编排产品。它们超出 Ticket 的持久化协调职责，并会把 Fusion 的关注点拉进该领域。[How Missions Work](https://factory.com/news/missions-architecture#the-system)。
2. **完整的 Workstream 产品语义。** 持久的多 Ticket 流、同步共享文件夹、多机器路由、PR 仪表盘和持续的任务接收，应保留为更高层的编排/工作区能力。公开文档并未证明有必要把它们并入 Ticket。[Workstreams overview](https://docs.factory.com/workstreams/overview#when-to-use-a-workstream)、[Workstream Machines](https://docs.factory.com/workstreams/machines#choose-where-agents-run)。
3. **Factory 特有的配额、套餐或 UI 可用性规则。** 这些是产品/服务层面的问题；Workstreams 的 beta 状态和套餐可用性明确属于 Factory 特有，不能作为 DSH 领域行为的依据。[Workstreams overview](https://docs.factory.com/workstreams/overview#workstreams)。
4. **臆测隐藏的实现细节。** 公开文档没有说明 Mission/Workstream 的 wire schema、持久化格式、重试算法、Worker 身份协议或确切的冲突解决语义。应将这些视为缺失或不确定，而不是照搬名称或数据模型。

## 不确定与缺失

Factory 的公开文档说明了产品行为和架构原则，但**没有**发布完整的 Mission 或 Workstream 数据模型/API。尤其不确定的是：所列的每个 UI 状态是否都被持久化，Worker 身份如何编码，除已述的协调行为外冲突如何解决，以及共享文件夹的历史是否基于事件溯源。本文查阅的公开来源中，没有一个记录了类似 Ticket 的比较并交换版本协议、类似 Job 的输出环约定，或稳定的跨界面 wire schema。不应根据 UI 描述推断这些概念。

## 来源

查阅的一手来源：

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
