---
description: "持久化 Ticket 生命周期、直接 Worker 分配、报告、问题、关注项和协调者交接。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-ticket

[English](README.md) | 中文

## Summary

Ticket 是由软协调者和直接 Worker 共同处理一项工作的持久化协调记录。Host 服务把完整 Ticket 快照写入 Session 事件日志，并通过 `ctx.sessionProjections` 同步恢复。分配、执行槽位、工作范围、报告、问题、关注项、协调者交接、比较并交换版本以及终态结果都属于此领域。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

将 `@deepseek-ai/dsh-experimental-ticket` 与持久化 Session 和 `@deepseek-ai/dsh-session-projection` 一起挂载。包会注册 `ctx.tickets` 和 `ticket` Session 投影。它以一个 Session 作为持久化权威，不建立第二个数据库。

服务提供 `create`、`assign`、`claim`、`release`、`report`、`ask`、`attention`、`block`、`handoff`、`complete`、`fail` 和 `cancel`。修改命令携带 `expectedRevision`；过期版本返回 `TICKET_STALE_REVISION`，不会覆盖更新后的状态。Worker 是后续执行适配器提供的直接 Session 身份。此包只记录执行槽位和工作范围声明。

[Session 投影](../../session/session-projection/README.zh.md) 是浏览器安全的读取路径。每个 `ticket/state` 事件包含完整的变更后值，因此打开 Session 或重放事件会得到相同状态，并拒绝格式错误或版本不连续的记录。

## Understand the implementation

包由三个层次组成：

- [`src/types.ts`](src/types.ts) 负责品牌化 id、JSON 兼容快照、请求值、浏览器投影类型和持久化事件声明。
- [`src/projection.ts`](src/projection.ts) 同步验证并折叠 `ticket/state` 事件，拒绝版本间隙、不可变身份变化、嵌套 id 重复和非法生命周期转换。
- [`src/index.ts`](src/index.ts) 按 Session 串行化命令，执行权限和数量限制，通过 `ctx.sessions` 写入完整快照并提供 `ctx.tickets` 服务接口。

此包有意独立于 Fusion、Agent Teams、Worktree、Jobs、UI、轮询和通用 Subagent 创建。后续包可以提供适配器，而 Ticket 继续负责分配和交接语义的持久化所有权。

<a id="model-experience"></a>
## Model Experience

### Host-only coordination state

#### What the model sees

此包不注册模型工具、提示词区段或自动事件触发器。Host-only 的 `ctx.tickets` 服务和仅日志的 `ticket/state` 事件不会进入模型上下文。后续适配器可以把 Ticket 视图或命令结果呈现给模型，模型可见文本由该适配器负责。

#### Token effect

Ticket 事件是日志记录，本身不会增加模型 token。

#### KV Cache effect

Ticket 状态变化不会修改请求头或模型提示词前缀。

## Known Limitations and Deferred Work

- 执行槽位和工作范围是持久化声明。Worktree 创建、进程所有权、Jobs 输出、重叠检查、清理和重启适配器留待后续包实现。
- 此包没有面向模型的工具或浏览器 UI。消费者决定哪些 Ticket 命令需要人工确认。
- Ticket 快照受部署配置限制，但首版不会压缩旧报告、问题或关注项历史。
- Ticket 位于一个 Session 日志中。跨 Session 复制和来源接入由适配器负责。

<a id="dev-note"></a>
### Dev Note

此包处于实验阶段，没有稳定性承诺。Session 事件是权威来源，投影检查点只用于加速重放。
