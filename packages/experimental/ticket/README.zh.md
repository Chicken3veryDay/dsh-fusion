---
description: "持久化 Ticket 生命周期、直接 Worker 分配、报告、问题、关注项和协调者交接。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-ticket

[English](README.md) | 中文

## 概述

Ticket 是由软协调者和直接 Worker 共同处理一项工作的持久化协调记录。Host 服务把完整 Ticket 快照写入 Session 事件日志，并通过 `ctx.sessionProjections` 同步恢复。分配、执行槽位、工作范围、报告、问题、关注项、协调者交接、比较并交换版本以及终态结果都属于此领域。

## 目录

- [使用本包](#use-this-package)
- [实现原理](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将 `@deepseek-ai/dsh-experimental-ticket` 与持久化 Session 和 `@deepseek-ai/dsh-session-projection` 一起挂载。包会注册 `ctx.tickets` 和 `ticket` Session 投影。它以一个 Session 作为持久化权威，不建立第二个数据库。

服务提供 `create`、`assign`、`claim`、`release`、`report`、`ask`、`answer`、`closeQuestion`、`attention`、`acknowledgeAttention`、`resolveAttention`、`block`、`handoff`、`complete`、`fail` 和 `cancel`。修改命令携带 `expectedRevision`；过期版本返回 `TICKET_STALE_REVISION`，不会覆盖更新后的状态。Worker 是执行适配器提供的直接 Session 身份。当前协调者可以回答未解决的问题，并确认或解决关注项；问题作者也可关闭自己未解决或已回答的问题。确认关注项不会解除阻塞。Worker 的进度、认领和释放操作会保留未解决的问题及关注项；解除最后一项阻塞后，根据分配状态重新计算就绪状态。已结束或已释放的分配拒绝报告。

需要让模型协调时挂载 `TicketTools`，它注册 `ticket_*` 命令。需要共享目录、隔离 Worktree 或由 Worker Session 所有的后台任务时，和 Jobs、Worktree 提供者一起挂载 `TicketExecutionService`。执行适配器会认领持久化 Assignment、检查直接 Worker 身份、在该 Session 下启动任务，并在清理时释放仍在运行的 Assignment。

[Session 投影](../../session/session-projection/README.zh.md) 是浏览器安全的读取路径。每个 `ticket/state` 事件包含完整的变更后值，因此打开 Session 或重放事件会得到相同状态，并拒绝格式错误或版本不连续的记录。命令准入和重放共用语义验证；无效命令不会追加事件。提议状态的 Ticket 不能直接完成。持久化刷新可能在追加后失败，重试前应读取当前版本。

工作范围将斜杠分隔的相对路径规范化，折叠 `.` 和 `..`，并拒绝越出工作区的路径、绝对路径、驱动器前缀及反斜杠。分配范围必须包含于声明的 Ticket 范围内，且不能把只读权限提升为写权限；Ticket 未声明范围时，分配的范围声明不受此限制。范围声明和 `exclusive` 用于协调 Worker 所有权，不会限制文件系统访问，也不通过锁强制互斥。

<a id="understand-the-implementation"></a>
## 实现原理

包由三个层次组成：

- [`src/types.ts`](src/types.ts) 负责品牌化 id、JSON 兼容快照、请求值、浏览器投影类型和持久化事件声明。
- [`src/projection.ts`](src/projection.ts) 同步验证并折叠 `ticket/state` 事件，拒绝版本间隙、不可变身份变化、嵌套 id 重复和非法生命周期转换。
- [`src/index.ts`](src/index.ts) 按 Session 串行化命令，执行权限和数量限制，通过 `ctx.sessions` 写入完整快照并提供 `ctx.tickets` 服务接口。

此包把 Fusion、Agent Teams、来源轮询和通用 Subagent 创建留在 Ticket 权威之外。可选的执行适配器组合现有 Jobs 和 Worktree 提供者，不把分配或交接的持久化语义移入这些包。

<a id="model-experience"></a>
## 模型体验

### Host 协调状态与可选工具

#### 模型看到的内容

核心服务和 `ticket/state` 事件不会进入模型上下文。`TicketTools` 是可选的，它注册返回 JSON Ticket 视图的直接 Worker 命令，不会创建 Worker，也不会绕过 CAS 版本检查。创建操作仅允许使用调用者自己的 Session 和协调者身份；转移协调权应使用交接命令。跨 Session 读取只公开调用者担任协调者或拥有分配的 Ticket。此包没有自动事件触发器。

#### Token 影响

Ticket 事件是日志记录，本身不会增加模型 token。

#### KV 缓存影响

Ticket 状态变化不会修改请求头或模型提示词前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 执行适配器在内存中负责 Jobs 和 Worktree 生命周期；Ticket 日志保留 Assignment 和槽位状态，具体任务与 checkout 的恢复仍由提供者负责。
- 此包没有来源接入策略或浏览器监督 UI。消费者决定哪些 Ticket 命令和执行模式需要人工确认。
- Ticket 快照受部署配置限制，但首版不会压缩旧报告、问题或关注项历史。
- Ticket 位于一个 Session 日志中。跨 Session 复制和来源接入由适配器负责。

<a id="dev-note"></a>
### 开发备注

此包处于实验阶段，没有稳定性承诺。Session 事件是权威来源，投影检查点只用于加速重放。
