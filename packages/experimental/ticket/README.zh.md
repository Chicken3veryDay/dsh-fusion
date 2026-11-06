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

将 `@deepseek-ai/dsh-experimental-ticket` 与持久化 Session 和 `@deepseek-ai/dsh-session-projection` 一起挂载。包会注册 `ctx.tickets` 和 `ticket` Session 投影。Session 拥有持久化状态；每个公开修改操作都要求在 `ctx.agents.withInitiator` 中使用已注册的确切 Agent，并在提供 `actorId` 时与之匹配。创建操作要求技术所有者调用；该所有者也可通过 `handoff` 收回协调权。缺失、过期或冒用的调用者返回 `TICKET_AUTHORITY`。

服务提供 `create`、`assign`、`claim`、`release`、`report`、`ask`、`answer`、`closeQuestion`、`attention`、`acknowledgeAttention`、`resolveAttention`、`block`、`handoff`、`complete`、`fail` 和 `cancel`。修改命令携带 `expectedRevision`；过期版本返回 `TICKET_STALE_REVISION`，不会覆盖更新后的状态。Worker 是执行适配器提供的直接 Session 身份。当前协调者可以回答未解决的问题，并确认或解决关注项；问题作者也可关闭自己未解决或已回答的问题。确认关注项不会解除阻塞。Worker 的进度、认领和释放操作会保留未解决的问题及关注项；解除最后一项阻塞后，根据分配状态重新计算就绪状态。已结束或已释放的分配拒绝报告。 规格编辑会重新开放没有尝试历史的已完成贡献，供模型提交新报告，同时保留旧报告历史。有尝试历史的分配需要宿主准入新尝试；旧式认领不能重新开放它们。

当模型需要通过 `ticket_*` 命令协调时挂载 `TicketTools`。当分配需要共享工作区、隔离 worktree或自有后台任务时，挂载 `TicketExecutionService` 并提供 Jobs 和 Worktree 服务。执行适配器准入持久化尝试，检查直接 Worker 身份，并跨句柄串行化内部 Ticket 更新。启动生产者前，它保持运行时身份不变，并把每个 job id 追加到回执中。调用者取消监听保留到生产者结算或句柄成功清理；失败 Job 优先于已取消 Job，二者均阻止成功。清理仅在结算后释放活动分配。

[Session 投影](../../session/session-projection/README.zh.md) 是浏览器安全的读取路径。每个 `ticket/state` 事件包含完整的变更后值，因此打开 Session 或重放事件会得到相同状态，并拒绝格式错误或版本不连续的记录。命令准入和重放共用语义验证；无效命令不会追加事件。提议状态的 Ticket 不能直接完成。持久化刷新可能在追加后失败，重试前应读取当前版本。 旧版 v1 报告投影到合成的初始规格，因此保留的结果可以进入 v2 候选而无需改写旧事件。

工作范围规范化以斜杠分隔的相对路径，折叠 `.` 和 `..`，并拒绝工作区逃逸、绝对路径、驱动器前缀和反斜杠。分配范围必须位于声明的 Ticket 范围内，且不能从读权限提升为写权限；未声明范围的 Ticket 不限制分配声明。尝试准入会在同一共享执行环境中原子排斥重叠写范围，只要任一声明为独占。预留覆盖所属 Session 中的所有 Ticket，并在停止或未知状态下保留到结算。隔离 worktree和不同执行环境相互独立；范围不会限制文件系统访问。

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

核心服务和 `ticket/state` 事件不会进入模型上下文。`TicketTools` 是可选的，它注册返回 JSON Ticket 视图的直接 Worker 命令，不会创建 Worker，也不会绕过 CAS 版本检查。规格修订、候选提交和标准检查使用 `ticket_revise`、`ticket_submit_candidate` 和 `ticket_check_candidate`；尝试保持由宿主所有，`ticket_report` 接收当前活动的 `attempt_id`。创建操作仅允许使用调用者自己的 Session 和协调者身份；转移协调权应使用交接命令。跨 Session 读取只公开调用者担任协调者或拥有分配的 Ticket。此包没有自动事件触发器。

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
