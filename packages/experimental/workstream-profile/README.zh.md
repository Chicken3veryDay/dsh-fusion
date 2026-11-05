---
description: "用一个实验性 profile 层启用 Ticket、Workstream 与 Workstream Evidence 服务及其模型工具。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-workstream-profile

[English](README.md) | 中文

## 概述

`dsh-experimental-workstream-profile` 挂载 [Ticket](../ticket/README.zh.md)、[Workstream](../workstream/package.json) 与 [Workstream Evidence](../workstream-evidence/package.json) 服务，并注册它们的 `ticket_*`、`workstream_*` 与 `workstream_evidence_*` 模型工具。Ticket 是唯一的工作看板；Workstream 增加成员、协调者交接和带确认的消息；Evidence 增加不可变的共享产物。本层不挂载 Agent Teams，默认不在插件列表中显示，只能添加到已初始化的 profile。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 安装到 profile

```sh
dsh plugin --profile headless add @deepseek-ai/dsh-experimental-workstream-profile
dsh --profile headless "Open a Workstream, create a Ticket, and assign it to a new member."
```

profile 必须已经包含 `@deepseek-ai/dsh-base`，本层会使用其中的 Session、Subagent 与附件服务。执行 `dsh plugin --profile <name> remove @deepseek-ai/dsh-experimental-workstream-profile` 移除本层。

### 获得的功能

patch 在 `dsh-base` 之后插入三个服务和三个工具行：

| 行 | 挂载 | 模型工具 |
|---|---|---|
| `tickets`、`tool-ticket` | `ctx.tickets` | `ticket_*` |
| `workstreams`、`tool-workstream` | `ctx.workstreams` | `workstream_*` |
| `workstream-evidence`、`tool-workstream-evidence` | `ctx.workstreamEvidence` | `workstream_evidence_*` |

patch 中每个服务限制都是显式 Config 值，与包默认值相同。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

运行时内容是 [`cordis.patch.yml`](cordis.patch.yml)。三个工具类是各自包的具名导出，而 Loader 只挂载模块的默认导出，因此本包用单行入口把它们重新导出为默认导出：`./ticket-tools`、`./workstream-tools` 与 `./workstream-evidence-tools`。

Agent Teams 保持未挂载。`WorkstreamService` 通过 `ctx.subagents` 的收件箱投递消息、中断和停止，并记录持久的接收回执，因此不需要 Team roster 或 `ctx.agentTeams`。挂载 Agent Teams 会在 Ticket 之外增加第二个 `team_task_*` 看板。base 的 `subagent`、`list_agents` 与 `send_message` 工具仍然可用，且绕过 Workstream 授权；Workstream 成员请使用 `workstream_*` 工具。

`TicketExecutionService` 未挂载：它需要 base profile 不提供的 Worktree 提供方。

| 文件 | 职责 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 叠加在 `dsh-base` 之上的有序 patch |
| [`src/ticket-tools.ts`](src/ticket-tools.ts)、[`src/workstream-tools.ts`](src/workstream-tools.ts)、[`src/workstream-evidence-tools.ts`](src/workstream-evidence-tools.ts) | 工具类的默认导出 Loader 入口 |
| [`tests/composition.spec.ts`](tests/composition.spec.ts) | `dsh` 进程测试：服务与模型可见工具列表，含启用和未启用本层两种情形 |
| [`tests/profile.spec.ts`](tests/profile.spec.ts) | patch 结构、默认导出，以及不出现在随产品发布的组合中 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [实验性包](../README.zh.md)——孵化状态与发布规则。
- [Ticket](../ticket/README.zh.md)——持久工作项服务及其工具。
- [Agent Teams profile](../agent-team-profile/README.zh.md)——使用 Team 任务板的替代方案。
- [Base bundle](../../bundle/base/README.zh.md)——本 patch 扩展的 profile 层。

-----

<a id="model-experience"></a>
## 模型体验

### Ticket、Workstream 与 Evidence 工具

#### 模型看到什么

35 个 `ticket_*`、`workstream_*` 与 `workstream_evidence_*` 工具 schema，以及 `TicketTools` 注册的 `ticket-tools:policy` 系统提示段。本层自身不添加文本。

#### Token 影响

本层增加三个包的工具 schema 和一个策略段。

#### KV Cache 影响

patch 与已配置工具不变时，系统提示与工具 schema 保持前缀稳定。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅限显式启用**——随产品发布的 CLI、Web、SDK、ACP 或 Python profile 均不启用本层。
- **无执行服务**——挂载 Jobs 与 Worktree 提供方的 Ticket 尝试执行未启用。
- **无 Web UI**——本层只包含工具和服务。
- **需要 base profile**——patch 依赖 `dsh-base` 提供的服务。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

无。

</details>
