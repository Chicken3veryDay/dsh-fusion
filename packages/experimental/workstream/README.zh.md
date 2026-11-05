---
description: "持久化 Workstream 成员关系、协调者交接、带确认的 peer 消息，以及根 Session 所有的 Ticket 操作。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-workstream

[English](README.md) | 中文

## 概述

Workstream 是一个根 Session 的持久化团队记录。它把完整的 Workstream 快照写入根 Session 事件日志，并通过 `ctx.sessionProjections` 恢复。成员是根 Session 的可继续（continuable）直接子 Session。根 Session 保持技术所有权，协调者权限可在成员之间转移。Peer 消息有独立的已接收与已处理回执。Ticket 的创建、分配和完成在根 Session 下通过 `ctx.tickets` 执行。

## 目录

- [使用本包](#use-this-package)
- [实现原理](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将 `@deepseek-ai/dsh-experimental-workstream` 与 `@deepseek-ai/dsh-experimental-ticket`、带有可继续提供方的 Subagent、持久化 Session 存储以及 `@deepseek-ai/dsh-session-projection` 一起挂载。包会注册 `ctx.workstreams` 和 `workstream` Session 投影。每个方法都接收调用方当前存活的 `Agent`；过期或被替换的 `Agent` 对象会以 `WORKSTREAM_UNAUTHORIZED` 拒绝。

服务提供 `open`、`get`、`list`、`requireMembership`、`addMember`、`handoff`、`sendMessage`、`acknowledge`、`waitForChange`、`interrupt`、`stop`、`createTicket`、`assignTicket` 和 `endTicket`。只有根 Session 可以调用 `open`。一个根 Session 至多拥有一个 Workstream，对同一 `operationId` 和标题重复调用 `open` 是幂等的。所有者是角色为 `owner` 的第一个成员，同时也是第一任协调者。`addMember` 通过指定的 Subagent 提供方创建可继续的子 Session，该提供方必须实现 `prepareContinuable`。`handoff` 把协调者权限转移给一个活跃成员，并接收 `expectedRevision`；版本已变化时返回 `WORKSTREAM_CONFLICT`。交接后，子 Session 仍以根 Session 为父。协调者操作（`addMember`、`handoff`、`interrupt`、`stop`、`assignTicket`、`endTicket`）要求调用方是不可变的所有者或当前协调者。`stop` 拒绝所有者和当前协调者，因此协调者要先交接，才能停止自己。

每个修改操作都接收由调用方选定的 `operationId`。用不同输入复用同一 id 会返回 `WORKSTREAM_CONFLICT`。结果不确定后，成员创建和消息投递不会重复执行：服务返回 `WORKSTREAM_UNKNOWN`，用相同 id 重试时，服务会先读取子 Session 日志确认是否已接收，再记录进展。消息依次经过 `intent`、`accepted`（接收方收件箱已收下）和 `processed`（接收方调用了 `acknowledge`）。接收方空闲并不意味着 `processed`。`sendMessage` 接收可选的 `WorkstreamContextPacket`，它会随消息写入日志并投递给接收方。

`waitForChange` 在根 Session 追加任意事件（包括 Ticket 事件）时、`timeoutMs` 到期时返回，调用方中止或服务关闭时则拒绝。`timeoutMs` 必须是不超过 `maxWaitMs` 的正整数。若 Workstream 版本已不同于 `afterRevision`，它立即返回。

`createTicket`、`assignTicket` 和 `endTicket` 在根 Session 上转发给 `ctx.tickets`，并以所有者作为 Ticket 的 actor。任何活跃成员都可以提议 Ticket。分配要求目标是活跃的子成员，完成则适用 Ticket 的验收检查。

模型调用方需要使用服务时，挂载 `WorkstreamTools`。挂载工具是可选的，与服务相互独立。配置字段均为正的安全整数：`maxMembers`（16）、`maxMessages`（256）、`maxSnapshotBytes`（1048576）、`maxMessageBytes`（65536）和 `maxWaitMs`（3600000）。超出限制时返回 `WORKSTREAM_LIMIT`。

错误是 `WorkstreamError`，其 code 为 `WORKSTREAM_UNAUTHORIZED`、`WORKSTREAM_NOT_FOUND`、`WORKSTREAM_CONFLICT`、`WORKSTREAM_LIMIT`、`WORKSTREAM_INVALID_INPUT`、`WORKSTREAM_UNKNOWN` 或 `WORKSTREAM_DISPOSED`。`WORKSTREAM_UNKNOWN` 表示该效果可能已发生；再次操作前应检查持久化记录。

`workstream` 键的 [Session 投影](../../session/session-projection/README.zh.md) 是浏览器安全的读取路径，对未拥有 Workstream 的 Session 其值为 `null`。浏览器安全类型从 `@deepseek-ai/dsh-experimental-workstream/client` 导入，类型从 `@deepseek-ai/dsh-experimental-workstream/types` 导入。

<a id="understand-the-implementation"></a>
## 实现原理

包由四个小层次组成：

- [`src/types.ts`](src/types.ts) 负责快照、成员、消息、上下文包、请求和配置类型，以及 `workstream/state` 事件、`workstream` 投影和 `workstream-message` 消息来源的声明。
- [`src/projection.ts`](src/projection.ts) 用严格的 schema 验证每个 `workstream/state` 事件，忽略 `ownerSessionId` 与被折叠 Session 不同的事件，并拒绝版本间隙和创建 `operationId` 的变化。
- [`src/index.ts`](src/index.ts) 按根 Session 串行化操作，执行权限和数量限制，以 `version: 1` 追加完整快照，通过 `ctx.sessions` 刷新，并提供 `ctx.workstreams`。
- [`src/tools.ts`](src/tools.ts) 通过 `ctx.tools` 注册可选的 `workstream_*` 工具。

根 Session 是唯一的技术所有者，也是 `workstream/state` 的唯一写入者。消息是否被接收，由接收方 Session 日志中的 `workstream-message` 来源确认，该来源携带根 Session id、操作 id 和发送方 id，因此重试不会发送第二份。关闭时，服务会中止等待、等待进行中的操作完成，并排空成员子 Session。

<a id="model-experience"></a>
## 模型体验

### 可选的 Workstream 工具

#### 模型看到的内容

`WorkstreamTools` 注册 13 个工具：`workstream_open`、`workstream_get`、`workstream_list`、`workstream_add_member`、`workstream_send`、`workstream_acknowledge`、`workstream_handoff`、`workstream_wait`、`workstream_interrupt`、`workstream_stop`、`workstream_create_ticket`、`workstream_assign_ticket` 和 `workstream_end_ticket`。多数工具接收 `root_session_id`，可重试的修改操作还接收 `operation_id`。结果是服务返回值的 JSON，渲染为一个文本块。`workstream_interrupt` 返回 `{ "interrupted": true }`。`workstream_send` 没有上下文包参数。这些工具不在生成的工具目录中，因为没有任何已发布的 profile 注册它们。

#### Token 影响

`WorkstreamTools` 挂载期间，每个已注册工具的定义都会增加 schema token。每次调用返回受影响的完整值（JSON）：`workstream_get` 返回所有成员和消息回执，因此其大小随 `maxMembers` 和 `maxMessages` 增长。

#### KV 缓存影响

注册或移除这些工具会改变工具列表，可能使暴露它们的 Session 的已缓存请求前缀被替换。工具结果产生之后仅追加增长。

### Peer 消息与成员提示词

#### 模型看到的内容

接收方看到一条用户消息，其内容是 JSON 文本块 `{"sender":<Session id>,"text":<消息文本>,"context":<上下文包或 null>}`，消息来源类型为 `workstream-message`。所有者以引导（steer）消息的形式收到它，子 Session 则通过 Subagent 收件箱收到。新成员把传给 `workstream_add_member` 的 `prompt` 作为第一条提示词。这些文本在运行时由调用方提供，不由本包拥有。

#### Token 影响

每条消息把其序列化大小加入接收方的上下文，完整的已存储消息受 `maxMessageBytes` 限制。成员提示词存储在快照中，因此受 `maxSnapshotBytes` 限制。

#### KV 缓存影响

两类条目都追加到接收方自己的对话中，不改变发送方的请求前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- Workstream 以一个存活的根 Session 为根。操作另一个 Session 的 Workstream 需要其根 `Agent` 存活，跨根 Workstream 未建模。`list` 至多返回调用方自己根 Session 的 Workstream。
- 成员是根 Session 的可继续直接子 Session。嵌套的子 Session 无法加入，已停止的成员仍保留其名称。
- 此包没有浏览器监督 UI，也没有针对已收到消息的自动触发器；接收方通过自己的收件箱得知消息，并可调用 `workstream_wait`。
- `workstream_send` 无法附带上下文包。需要上下文包的调用方应直接使用服务方法。
- 快照保留所有成员和消息回执，不做压缩；限制作用于完整快照，因此长期存在的 Workstream 会达到 `WORKSTREAM_LIMIT`。
- Ticket 操作以根所有者作为 Ticket 的 actor 和协调者，所以交接 Workstream 协调者不会改变已创建 Ticket 中记录的协调者。
- 不确定的成员创建或消息投递返回 `WORKSTREAM_UNKNOWN`。仅当调用方用同一操作重试时，服务才会对账；它从不自行重新启动子 Session 或重发消息。

<a id="dev-note"></a>
### 开发备注

此包处于实验阶段，没有稳定性承诺。Session 事件是权威来源，投影检查点只用于加速重放。
