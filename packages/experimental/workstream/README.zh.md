---
description: "持久化 Workstream 成员关系、协调者交接、带确认的 peer 消息，以及根 Session 所有的 Ticket 操作。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-workstream

[English](README.md) | 中文

## 概述

Workstream 是一个根 Session 的持久化团队记录。它把完整的 Workstream 快照写入根 Session 事件日志，并通过 `ctx.sessionProjections` 恢复。成员是根 Session 的可继续（continuable）直接子 Session。根 Session 保持技术所有权，协调者权限可在成员之间转移。Peer 消息有独立的已接收与已处理回执。Ticket 的创建、分配和完成在根 Session 下通过 `ctx.tickets` 执行，Ticket 的协调权随 Workstream 协调者移动。

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

服务提供 `open`、`get`、`list`、`requireMembership`、`addMember`、`handoff`、`sendMessage`、`acknowledge`、`cursor`、`waitForChange`、`interrupt`、`stop`、`createTicket`、`assignTicket` 和 `endTicket`。只有根 Session 可以调用 `open`。一个根 Session 至多拥有一个 Workstream，对同一 `operationId` 和标题重复调用 `open` 是幂等的。所有者是角色为 `owner` 的第一个成员，同时也是第一任协调者。`addMember` 通过指定的 Subagent 提供方创建可继续的子 Session，该提供方必须实现 `prepareContinuable`。`handoff` 把协调者权限转移给一个活跃成员，并接收 `expectedRevision`；版本已变化时返回 `WORKSTREAM_CONFLICT`。交接后，子 Session 仍以根 Session 为父。协调者操作（`addMember`、`handoff`、`interrupt`、`stop`）要求调用方是不可变的所有者或当前协调者。`assignTicket` 和 `endTicket` 要求调用方就是在任的协调者，因为 Ticket 会把调用方记为 actor；所有者要先用 `handoff` 取回该角色。`stop` 拒绝所有者和当前协调者，因此协调者要先交接，才能停止自己。`stop` 在根队列内提交 `stopping` 阶段，子 Session 排空期间释放该队列，使其自身排队的 Workstream 工具调用可以完成，然后根据当前状态提交 `stopped`。`addMember` 和 `sendMessage` 遵循同一规则，因为任何操作都不能在持有成员自身 Workstream 工具所需队列的同时等待该成员：它们在队列内提交意图；无法确认的启动在释放队列后排空，消息在释放队列后投递；`sendMessage` 再回到队列内提交回执。对仍在投递中的消息用同一 id 重试，会加入该投递。`stop` 在排空前先等待发往目标的投递结束，因此投递不会在排空之后重新恢复该成员。

`open`、`addMember` 和 `sendMessage` 接收由调用方选定的 `operationId`，`acknowledge` 则给出被确认消息的 `operationId`。`handoff` 由 `expectedRevision` 保护，`stop` 和 `interrupt` 作用于成员的当前阶段且不带操作 id，Ticket 操作由 Ticket 版本保护。用不同输入复用同一操作 id 会返回 `WORKSTREAM_CONFLICT`。结果不确定后，成员创建和消息投递不会重复执行：服务返回 `WORKSTREAM_UNKNOWN`，用相同 id 重试时，服务会先读取子 Session 日志确认是否已接收，再记录进展。消息依次经过 `intent`、`accepted`（接收方收件箱已收下）和 `processed`（接收方调用了 `acknowledge`）。接收方空闲并不意味着 `processed`。`sendMessage` 接收可选的 `WorkstreamContextPacket`，它会随消息写入日志并投递给接收方。重试时若发现先前结果已记录（已打开的 Workstream、已激活的成员、已接收或已处理的消息（即使接收方已停止）、已停止的成员），会先刷新根 Session 再返回，因此首次尝试在追加后写入失败时，不会被报告为已提交；存储故障持续时重试会被拒绝。

Workstream 所有者被恢复时，服务会读取每个没有已注册 Agent 的活动子成员的 Session 日志。若成员的最后一轮仍未结束，或以 `aborted`、`interrupted` 结束，则它没有完成：关闭或重新加载排空了它，且没有任何机制恢复它。它的成员身份仍为 `active`，其 Ticket 分配仍可能显示 `running`。服务会向所有者注入一条 `workstream-notice` 消息，列出每个此类成员的名称、Session id 和轮次号，并指明用 `workstream_send` 让它继续、用 `workstream_stop` 停止它。日志无法读取的成员显示为 `log unreadable`，所有者恢复照常进行。注入不会唤醒所有者；它的下一次请求会带上该通知。只要成员的最后一轮仍未完成，每次恢复所有者都会再次写入该通知。

`cursor` 返回调用方的等待游标：根 Session 中最后一个已提交事件之后的位置。`waitForChange` 接收 `afterRevision`、可选的 `afterCursor`、`timeoutMs` 和调用方信号，返回带当前 Workstream 版本和游标的 `{ timedOut, revision, cursor }`。若版本已不同于 `afterRevision`，或游标处及之后已提交了相关事件，它立即返回；未传 `afterCursor` 时，游标是提交 `afterRevision` 的事件之后的位置。否则它在下一个相关事件到来或 `timeoutMs` 到期时返回，调用方中止或服务关闭时则拒绝，即使变更已可见也是如此。相关事件指 Workstream 变更和根 Ticket 变更：对所有者和在任协调者是全部 Ticket，对其他成员只是把它记为协调者或 Assignment 所有者的 Ticket，包括它自己造成的变更。其他根事件（例如所有者自己的轮次）永远不会结束等待。`timeoutMs` 必须是不超过 `maxWaitMs` 的正整数；`afterCursor` 必须是不超过当前游标的非负整数，否则返回 `WORKSTREAM_INVALID_INPUT`。把返回的版本和游标传给下一次等待，每个相关变更就只报告一次；只传版本的等待会一直报告该版本之后提交的 Ticket 变更。

`createTicket`、`assignTicket` 和 `endTicket` 在根 Session 上转发给 `ctx.tickets`。`createTicket` 把当前 Workstream 协调者记为 Ticket 的协调者，`assignTicket` 和 `endTicket` 把经过认证的调用方作为 Ticket 的 `actorId`，因此 Ticket 历史能显示是谁在协调。任何活跃成员都可以提议 Ticket。分配要求目标是活跃的子成员。Workstream 还会注册 Ticket 分配授权方，因此对有 Workstream 的根直接调用 `ctx.tickets.assign` 时，除非受派人在分配提交时是活跃的子成员，否则以 `TICKET_AUTHORITY` 拒绝，即使停止操作在分配排在 Ticket 队列中等待时已经完成；没有 Workstream 的根不受约束，Workstream 仍在加载时授权方返回可重试的 `TICKET_COORDINATOR_UNAVAILABLE`。Workstream 还会注册 Ticket 命令授权方：在有 Workstream 的根中，每个 Ticket 命令在提交时都必须由所有者或活跃的直接子成员发出；因此，命令在 Ticket 队列中等待期间被 `stop` 撤销成员资格的成员所发的命令，或者不是成员的实时 Agent 所发的命令，都以 `TICKET_AUTHORITY` 失败，原因为 `WORKSTREAM_UNAUTHORIZED`，且不追加任何内容。所有者的命令（包括 `handoff` 由所有者发起的 Ticket 交接）以及 Ticket 自身的结算和恢复写入不会被拒绝；Workstream 仍在加载时，其他调用方得到可重试的 `TICKET_COORDINATOR_UNAVAILABLE`。完成则适用 Ticket 的验收检查。传入其他 Session id 从不构成授权：Ticket 的权限属于在任协调者，并对照实时 `Agent` 检查。

`handoff` 让 Ticket 协调权随角色移动。它先通过 `ctx.tickets.handoff` 把所有由 Workstream 成员协调的未结根 Ticket 交给新协调者，再提交 Workstream 快照。移动任何 Ticket 之前会先检查最终快照大小，并且会重复列出未结 Ticket 直到没有剩余，因此交接期间通过 `ctx.tickets` 创建的 Ticket 也会一并移动。最后一次空列表检查与快照追加在同一个同步步骤中完成，其间不会出现新的 Ticket；之后默认指向所有者的直接 `ctx.tickets.create` 会通过 Workstream 注册的 Ticket 协调授权方记录当前在任的协调者。该授权方在投影注册完成之前就已安装，并在已恢复的快照可读之前以 Ticket 的可重试 `TICKET_COORDINATOR_UNAVAILABLE` 拒绝默认指向所有者的 `create`（不追加任何内容），其消息提示重试，原因为 `WORKSTREAM_NOT_READY`，因此重新加载期间创建的 Ticket 不会记录所有者而永远得不到调和；Workstream 加载完成后重试即可。明确指定的非所有者协调者不受影响。快照是提交点，所以 Workstream 协调者不会指向 Ticket 尚未跟随的成员。每个 Ticket 在一次调用中最多移动一次：被竞争写入方交回的 Ticket，或服务开始关闭后的任何移动，都会以 `WorkstreamPartialHandoffError` 结束调用（服务已停止且尚未移动任何 Ticket 时抛出 `WORKSTREAM_DISPOSED`），而不是无限重复列出。目标必须是已注册的存活 Agent，与 `ctx.tickets.handoff` 的要求一致，因为已被排空或卸载的子 Agent 仍保留持久化的 `active` 成员身份。`handoff` 在移动任何 Ticket 之前检查一次，并在与快照追加相同的同步步骤中再检查一次；尚未移动任何 Ticket 时抛出 `WORKSTREAM_INVALID_INPUT`，若目标在部分 Ticket 移动后消失，则抛出带有已移动 id 的 `WorkstreamPartialHandoffError` 且协调者保持不变，再交接给存活成员即可恢复。没有已注册 Agent 的活动子成员（因为它已结束本轮或进程已重启）会先经由 Subagent 冷恢复，并收到一条 `workstream-notice` 消息，告知协调者角色正在交给它；该通知会开启它的一轮。恢复在根队列内执行：没有已注册 Agent 的成员没有运行中的驱动器，因此它的 Workstream 工具调用不可能正在该队列中等待，而它在恢复后发出的 Workstream 调用会在提交之后执行。它的 Ticket 读取不经过该队列，因此提交前的读取仍会显示原协调者。恢复失败时抛出 `WORKSTREAM_INVALID_INPUT`，不提交任何内容，并指明可先用 `workstream_send` 启动该成员再重试。已有已注册 Agent 的成员不会收到通知。Ticket 自身的交接必须由该 Ticket 当前的协调者授权，因此 Workstream 把所有者作为交接 actor 传入，Ticket 无需该 Ticket 协调者的授权即接受所有者。Ticket 不记录交接 actor。若有 Ticket 无法移动，`handoff` 抛出 `WorkstreamPartialHandoffError`（code 为 `WORKSTREAM_PARTIAL_HANDOFF`），带有 `moved` 和 `pending` 的 Ticket id，并保持 Workstream 协调者不变。重复同一调用即可移动剩余 Ticket；已在目标名下的 Ticket 会被跳过。移动 `proposed` 状态的 Ticket 会把它设为 `coordinating`，与 Ticket 的交接一致。

卸载服务时，先拒绝新的 Workstream 调用并撤回其 Ticket 授权方，因此之后进入队列的 Ticket 命令不再受其约束。随后它等待自身排队的操作，并对每个有 Workstream 的根等待 `ctx.tickets.whenIdle`，然后才排空成员。Ticket 用每个先前进入队列的命令进入队列时已注册的授权方来决定该命令，因此卸载开始时已经排队的 Ticket 命令仍按 Workstream 的规则提交或失败。

模型调用方需要使用服务时，挂载 `WorkstreamTools`。挂载工具是可选的，与服务相互独立。配置字段均为正的安全整数：`maxMembers`（16）、`maxMessages`（256）、`maxSnapshotBytes`（1048576）、`maxMessageBytes`（65536）和 `maxWaitMs`（3600000）。超出限制时返回 `WORKSTREAM_LIMIT`。

错误是 `WorkstreamError`，其 code 为 `WORKSTREAM_UNAUTHORIZED`、`WORKSTREAM_NOT_FOUND`、`WORKSTREAM_CONFLICT`、`WORKSTREAM_LIMIT`、`WORKSTREAM_INVALID_INPUT`、`WORKSTREAM_UNKNOWN`、`WORKSTREAM_DISPOSED`、`WORKSTREAM_PARTIAL_HANDOFF`、`WORKSTREAM_NOT_READY` 或 `WORKSTREAM_CAPACITY`。`WORKSTREAM_UNKNOWN` 表示该效果可能已发生；再次操作前应检查持久化记录。`WORKSTREAM_CAPACITY` 表示 Subagent 在任何子 Session 存在之前，因每个根的激活上限（`maxActiveSubagents`）拒绝了该成员：`addMember` 会删除它已提交的 `provisioning` 记录，因此不会保留任何成员、名称或操作 id，错误信息会给出该上限。某个成员的回合结束或被停止后会释放一个名额；此时同一操作会创建该成员，若池仍然已满则再次返回 `WORKSTREAM_CAPACITY`。

`workstream` 键的 [Session 投影](../../session/session-projection/README.zh.md) 是浏览器安全的读取路径，对未拥有 Workstream 的 Session 其值为 `null`。浏览器安全类型从 `@deepseek-ai/dsh-experimental-workstream/client` 导入，类型从 `@deepseek-ai/dsh-experimental-workstream/types` 导入。

<a id="understand-the-implementation"></a>
## 实现原理

包由四个小层次组成：

- [`src/types.ts`](src/types.ts) 负责快照、成员、消息、上下文包、请求和配置类型，以及 `workstream/state` 事件、`workstream` 投影和 `workstream-message`、`workstream-notice` 消息来源的声明。
- [`src/projection.ts`](src/projection.ts) 用严格的 schema 验证每个 `workstream/state` 事件，忽略 `ownerSessionId` 与被折叠 Session 不同的事件，并拒绝版本间隙和创建 `operationId` 的变化。它还记录快照所在事件的位置、Workstream 打开后最新一个根 `ticket/state` 事件的位置，以及每个协调者或 Assignment 所有者对应的最新此类事件的位置，供 `waitForChange` 与游标比较。检查点仅在完整重放可以产生的状态下才被接受：已打开的快照始终带有其提交事件的位置，且记录的 Ticket 位置彼此一致。违反这些条件的检查点无法通过 schema 验证，缓存读取因此回退到完整日志，而不是恢复缺失的位置。
- [`src/index.ts`](src/index.ts) 按根 Session 串行化操作，执行权限和数量限制，以 `version: 1` 追加完整快照，通过 `ctx.sessions` 刷新，并提供 `ctx.workstreams`。
- [`src/tools.ts`](src/tools.ts) 通过 `ctx.tools` 注册可选的 `workstream_*` 工具。

根 Session 是唯一的技术所有者，也是 `workstream/state` 的唯一写入者。消息是否被接收，由接收方 Session 日志中的 `workstream-message` 来源确认，该来源携带根 Session id、操作 id 和发送方 id，因此重试不会发送第二份。关闭时，服务会中止等待、等待进行中的操作完成，并排空成员子 Session。

<a id="model-experience"></a>
## 模型体验

### 可选的 Workstream 工具

#### 模型看到的内容

`WorkstreamTools` 注册 13 个工具：`workstream_open`、`workstream_get`、`workstream_list`、`workstream_add_member`、`workstream_send`、`workstream_acknowledge`、`workstream_handoff`、`workstream_wait`、`workstream_interrupt`、`workstream_stop`、`workstream_create_ticket`、`workstream_assign_ticket` 和 `workstream_end_ticket`。多数工具接收 `root_session_id`，可重试的修改操作还接收 `operation_id`。结果是服务返回值的 JSON，渲染为一个文本块。`workstream_get` 在快照中加入 `cursor`，`workstream_wait` 接收 `after_revision`、可选的 `after_cursor` 和 `timeout_ms`，返回 `{ "timedOut": <boolean>, "revision": <number>, "cursor": <number> }`。`workstream_interrupt` 返回 `{ "interrupted": true }`。`workstream_create_ticket` 接收可选的 `ticket_id`，重复的 id 会被拒绝。`workstream_send` 接收可选的 `context` 上下文包，包含 `requirements`、`decisions`、`cursor`、`changes` 和 `artifacts`（`ref` 与 `digest`）；包内每个字段都必填，多余字段会被拒绝，完整消息过大时在写入任何日志前返回 `WORKSTREAM_LIMIT`。这些工具不在生成的工具目录中，因为没有任何已发布的 profile 注册它们。

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

### Workstream 通知

#### 模型看到的内容

被 `workstream_handoff` 恢复的成员看到一条来源类型为 `workstream-notice` 的用户消息："The coordinator role of Workstream <root id> is being handed to you. When workstream_get shows your Session id as coordinatorId, you coordinate its Tickets: create, assign and end them, and hand the role back when done." 存在未完成成员的被恢复所有者看到一条同一来源类型的注入用户消息："These Workstream <root id> members are not running and their last turn did not finish, so their Ticket assignments may still read running: <name> (<Session id>, turn <n>); …. Send each a message with workstream_send to continue its work, or stop it with workstream_stop." 日志无法读取的成员显示为 `<name> (<Session id>, log unreadable)`。

#### Token 影响

交接通知约 50 个 token。所有者通知约 50 个 token，每列出一个成员再增加约 20 个，最多 `maxMembers` 个成员。

#### KV 缓存影响

两类通知都追加到接收方的对话中，不改变其先前的请求前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- Workstream 以一个存活的根 Session 为根。操作另一个 Session 的 Workstream 需要其根 `Agent` 存活，跨根 Workstream 未建模。`list` 至多返回调用方自己根 Session 的 Workstream；调用方不是其活跃成员（例如已停止的成员或根 Session 的普通子 Session）时返回空列表。
- 成员是根 Session 的可继续直接子 Session。嵌套的子 Session 无法加入，已停止的成员仍保留其名称。
- 此包本身没有 UI（[Web 面板](../client-ui-workstream/README.zh.md)展示它），也没有针对已收到消息的自动触发器；接收方通过自己的收件箱得知消息，并可调用 `workstream_wait`。
- 上下文包是调用方提供的文本；Workstream 不会自行汇总需求、决策或游标之后的变更，也不读取制品内容或校验摘要。
- 快照保留已停止的成员和每条消息回执；并发重试会等待同一进行中的交付。快照不会压缩；限制作用于完整快照，因此长期运行的 Workstream 会达到 `WORKSTREAM_LIMIT`。
- 交接会移动所有由 Workstream 成员协调的未结根 Ticket，包括直接通过 `ctx.tickets` 创建的 Ticket。Ticket 历史不记录是谁移动了 Ticket。并发的 Ticket 修改（包括所有者将其交回）可能让某个 Ticket 保持待移动状态，直到重试 `handoff`。创建时显式指定所有者之外协调者的直接 Ticket 会保持该协调者，直到交接将其移动。
- 被关闭或重新加载停止本轮的成员只会报告给被恢复的所有者，而不会被恢复；在所有者向它发送消息或停止它之前，它的成员身份仍为 `active`，Ticket 分配保持已记录的状态。该报告在每次恢复所有者时为每个此类成员读取一次 Session 日志，并在该成员最后一轮完成之前于每次恢复时重复。
- 不确定的成员创建或消息投递返回 `WORKSTREAM_UNKNOWN`。仅当调用方用同一操作重试时，服务才会对账；它从不自行重新启动子 Session 或重发消息。

<a id="dev-note"></a>
### 开发备注

此包处于实验阶段，没有稳定性承诺。Session 事件是权威来源，投影检查点只用于加速重放。
