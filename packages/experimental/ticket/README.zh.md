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

将 `@deepseek-ai/dsh-experimental-ticket` 与持久化 Session 和 `@deepseek-ai/dsh-session-projection` 一起挂载。包会注册 `ctx.tickets` 和 `ticket` Session 投影。Session 拥有持久化状态；每个公开修改操作都要求在 `ctx.agents.withInitiator` 中使用已注册的确切 Agent，并在提供 `actorId` 时与之匹配。创建操作要求技术所有者调用；该所有者也可通过 `handoff` 收回协调权。创建和交接都要求协调者是已注册且存活的 Agent。缺失、过期或冒用的调用者返回 `TICKET_AUTHORITY`。

服务提供 `create`、`assign`、`claim`、`release`、`report`、`ask`、`answer`、`closeQuestion`、`attention`、`acknowledgeAttention`、`resolveAttention`、`block`、`handoff`、`complete`、`fail` 和 `cancel`。修改命令携带 `expectedRevision`；过期版本返回 `TICKET_STALE_REVISION`，不会覆盖更新后的状态。Worker 是执行适配器提供的直接 Session 身份。当前协调者可以回答未解决的问题，并确认或解决关注项；问题作者也可关闭自己未解决或已回答的问题。确认关注项不会解除阻塞。Worker 的进度、认领和释放操作会保留未解决的问题及关注项；解除最后一项阻塞后，根据分配状态重新计算就绪状态。已结束或已释放的分配拒绝报告；执行成功结算后，分配仍保持开放，以便提交结果报告。 规格编辑会重新开放没有尝试历史的已完成贡献，供模型提交新报告，同时保留旧报告历史。有尝试历史的分配需要宿主准入新尝试；旧式认领不能重新开放它们。独占写分配必须使用带工作区身份的尝试，而不能使用旧式认领。候选提交若引用没有当前结果报告的分配，会返回包含分配身份的 `TICKET_ACCEPTANCE`。必需子 Ticket 约束验收；未完成、失败或取消的子 Ticket 不会阻止父 Ticket 取消或失败。所有尝试结算后，协调者可以从任何非终态让 Ticket 失败或取消，包括失败尝试释放分配后的 `ready`。

当模型需要通过 `ticket_*` 命令协调时挂载 `TicketTools`。当分配需要共享工作区、隔离 worktree或自有后台任务时，挂载 `TicketExecutionService` 并提供 Jobs 和 Worktree 服务。执行适配器准入持久化尝试，检查直接 Worker 身份，并获得绑定到尝试的记录器，将执行事实与所有 Ticket 命令串行化，无需调用者 CAS。准备操作必须匹配当前发起 Agent（若存在）。记录器在协调员交接或准备 Agent 销毁后仍可使用。启动生产者前，它保持运行时身份不变，并把每个 job id 追加到回执中。`prepare` 的信号只取消准备过程，句柄发布后不再保留；`startJob` 的信号会一直附着在其 Job 上，直到该生产者结算或句柄被清理。失败 Job 优先于已取消 Job，二者均阻止成功。销毁先请求取消，再执行持久化写入，即使 Agent 清理已删除 Job 记录，也等待保留的生产者承诺。Job 生产者只由其自身的 `done` 结算；抛出异常的取消请求会使停止失败，并由下一次销毁重试。激活的自然结算还会等待其 `dispose()` 确认资源已释放，因为其结果可能先于释放到达。等待中或超时的自然结算可升级为销毁。`settlementTimeoutMs` 限定每次完整的 `settle()` 或 `dispose()` 调用，包括等待中的 Job 准入、未知状态记录以及等待结算账本完成持久写入；失败或超时的停止以 `TICKET_ATTEMPT_STATE` 拒绝，其 `cause` 写明失败原因。生产者结果已知但账本写入在截止时仍未持久时，调用以可重试的 `TICKET_SETTLEMENT_PENDING` 拒绝：结果保持不变，账本继续写入，存储恢复后再次 `settle()` 或 `dispose()` 会重复该请求；对已移交尝试的重复请求使用同一截止时间。在生产者启动前取消或关闭会将尝试结算为已取消，并保留已知工作区回执。Worktree 创建失败时仍记为未知，因为检出可能已存在。以 `ACTIVATION_TEARDOWN_FAILED` 拒绝的 Subagent 启动未能回滚可能仍在运行的子级，因此同样记为未知；其他被拒绝的启动未建立子级，因此该尝试会结算。所有者释放回调不会自动重试失败的停止；显式释放和清理会以新的取消请求重试。生产者结果确定后，由 Ticket 负责结算直至其持久化，详见[尝试状态机](#attempt-state-machine)；若句柄的根 Session 已关闭，销毁会以可重试的 `TICKET_SETTLEMENT_PENDING` 拒绝，恢复该根后会写入结算。在任一准备阶段（包括准入刷新期间）销毁调用者、Worker 或根时，不会发布句柄，尝试结束为已取消，`prepare` 以 `TICKET_AUTHORITY` 拒绝。若准入本身的刷新失败，相同的 `prepare` 重试会重新刷新并继续准备；若没有重试，上述销毁或清理会将尝试结束为已取消。重复准备已结算尝试返回 `TICKET_ATTEMPT_STATE`。

为某个 Session 负责协调的包通过 `registerCoordinatorAuthority(authority)` 注册，并获得返回的释放函数。`create` 在该 Session 的命令队列内询问每个授权方，且与读取 Session 状态、追加 Ticket 处于同一个同步步骤。授权方收到请求的协调者（`CreateTicketRequest.coordinatorId`，缺省为 Session id），并可返回替代者；第一个替代者生效，因此协调权变化期间创建的 Ticket 总是记录追加时授权方决定的协调者。授权方抛出 `TicketError` 时，创建以该错误原样失败，例如仍在加载的授权方返回可重试的 `TICKET_COORDINATOR_UNAVAILABLE`；其他异常返回带有原始原因的 `TICKET_RECOVERY_FAILED`。两者都不追加任何内容。若协调者不是已注册且存活的 Agent，则返回 `TICKET_AUTHORITY`，错误会写明该协调者、是否由授权方选定，以及补救方法：恢复该 Agent，或把协调权交还给 Session 所有者。

负责决定谁可以接收工作的包通过 `registerAssignmentAuthority(authority)` 注册，并获得返回的释放函数。`assign` 在该 Session 的命令队列内、完成调用方、CAS、数量上限和主题检查之后、追加之前立即询问每个授权方，因此决定反映的是分配提交时受派人的状态，而不是调用发出时的状态。授权方收到 Session 和请求的 `ownerId`，通过抛出 `TicketError` 拒绝，此时分配以该错误原样失败且不追加任何内容；其他异常返回带有原始原因的 `TICKET_RECOVERY_FAILED`。没有注册授权方的 Session 接受任何受派人。分配授权方是下文命令授权方的 `assign` 情形。

负责决定谁可以在某个 Session 中操作的包通过 `registerCommandAuthority(authority)` 注册，并获得返回的释放函数。每个变更方法都在该 Session 的命令队列内、完成命令自身的调用方、角色和 CAS 检查之后、追加之前立即询问每个授权方，传入 Session、actor id（`create` 为创建它的发起方）和一个 `TicketCommand`。其 `kind` 是一个 `TicketCommandKind`：`create`、`assign`（另带 `assigneeId`）、`claim`、`release`、`report`、`ask`、`answer`、`close-question`、`attention`、`acknowledge`、`resolve`、`block`、`handoff`、`end`（对应 `complete`、`fail` 和 `cancel`）、`revise`、`submit-candidate`、`check-candidate`、`plan-mission`、`begin-attempt`、`update-attempt` 或 `settle-attempt`。拒绝即抛出 `TicketError`，命令以该错误原样失败且不追加任何内容；其他异常返回带有原始原因的 `TICKET_RECOVERY_FAILED`。执行所有者为结算和恢复写入的尝试记录不询问授权方。没有注册授权方的 Session 接受所有命令。

每个排队的命令由其进入队列时已注册的协调者授权方和命令授权方，加上提交前新注册的授权方共同决定。因此释放函数只让授权方不再约束其运行之后进入队列的命令。`whenIdle(session)` 在该 Session 于调用之前进入队列的所有命令都已提交或失败后完成；卸载的授权方所有者先撤回注册，再对其 Session 等待 `whenIdle`，然后才释放授权方读取的状态。

[Session 投影](../../session/session-projection/README.zh.md) 是浏览器安全的读取路径。每个 `ticket/state` 事件包含完整的变更后值，因此打开 Session 或重放事件会得到相同状态，并拒绝格式错误或版本不连续的记录。命令准入和重放共用语义验证；无效命令不会追加事件。提议状态的 Ticket 不能直接完成。持久化刷新可能在追加后失败，重试前应读取当前版本。幂等的尝试操作重试会再次刷新 Session，然后才报告成功，包括已被结算压缩进尝试墓碑记录的操作的重试。墓碑记录保留每个已退役操作的指纹，因此参数不同的压缩操作重试返回 `TICKET_OPERATION_CONFLICT`，将这类 id 用于另一个尝试则返回 `TICKET_ATTEMPT_STATE`。 旧版 v1 报告投影到合成的初始规格，因此保留的结果可以进入 v2 候选而无需改写旧事件。

工作范围规范化以斜杠分隔的相对路径，折叠 `.` 和 `..`，并拒绝工作区逃逸、绝对路径、驱动器前缀和反斜杠。分配范围必须位于声明的 Ticket 范围内，且不能从读权限提升为写权限；未声明范围的 Ticket 不限制分配声明。尝试准入会在同一共享执行环境中原子排斥重叠写范围，只要任一声明为独占。范围检查和追加同步执行；无关根无需等待另一根的刷新。预留在根 Session 关闭后仍保留，并在停止、未知状态或结算刷新失败期间持续持有。激活不读取任何存储日志。第一次共享工作区准入会列出存储，并只折叠每个未存活存储根的 `ticket/state` 事件，不恢复生产者；之后的准入复用这次扫描。列出失败或存储根无法读取时，共享工作区准入以写明原因或根的 `TICKET_RECOVERY_FAILED` 拒绝，下一次准入会重试。根的存储 Session 已不存在时，其预留会被释放，除非本宿主中仍有所有者在等待其生产者的结果；删除日志并不代表生产者已结算，因此该所有者的预留会在其把结果交给账本后才释放。存活根重放失败时仅针对该根报告并保留其已知范围；无关范围仍可使用。隔离 worktree和不同执行环境相互独立；范围不会限制文件系统访问。`TicketExecutionService` 准入的每个尝试，还会在其准入被记录时在根上下文中注册一项预留，任一代 Ticket 服务的每次准入都会通过 `ticket/collect-reservations` 事件收集其中的共享工作区预留。此类预留在以下情况离开：尝试交给结算账本或被释放时；其根 Session 日志记录该尝试已结算时；或在尝试变为 `unknown` 之后，其生产者自身的信号证明它们已停止时，即使准入它的执行服务已被清理。因此，即使根日志已被删除、Job 记录已被移除，被替换的服务仍会排斥仍在写入的生产者。

<a id="understand-the-implementation"></a>
## 实现原理

包由三个层次组成：

- [`src/types.ts`](src/types.ts) 负责品牌化 id、JSON 兼容快照、请求值、浏览器投影类型和持久化事件声明。
- [`src/projection.ts`](src/projection.ts) 同步验证并折叠 `ticket/state` 事件，拒绝版本间隙、不可变身份变化、嵌套 id 重复和非法生命周期转换。
- [`src/index.ts`](src/index.ts) 按 Session 串行化命令，执行权限和数量限制，通过 `ctx.sessions` 写入完整快照并提供 `ctx.tickets` 服务接口。

<a id="attempt-state-machine"></a>
### 尝试状态机

[`src/attempt-lifecycle.ts`](src/attempt-lifecycle.ts) 是规范。`TicketExecutionService` 把执行所有的尝试的每个事件都交给 `transitionAttempt`（其阶段的唯一写入者），并执行新阶段的进入动作。下表由该函数渲染；表格与函数不一致时测试失败。

阶段：`admitting` 在 `beginAttempt` 追加并刷新准入期间持有执行预留。`unflushed` 是已在内存日志中但刷新失败的准入。`preparing` 记录工作区和运行时回执，此时不存在生产者。`worktree` 和 `activating` 等待 Worktree 或 Subagent 提供者。`launched` 在发布前持有已建立的激活。`running` 是已发布的句柄。`stopping` 观察所有生产者；`natural` 和 `cancel` 表示持续保留的取消意图。`unknown` 是未能确认生产者结算的停止。在这两个阶段中，`captured` 是生产者在资源释放失败之前报告的结果；它是最终结果，并优先于之后的取消意图。`uncertain` 是提供者失败，之后可能仍存在 Worktree 检出或 Subagent 子级。`handed` 表示结算账本持有结果。`released` 表示没有尝试被准入。

事件：`caller-abort` 是 `prepare` 的信号，只在该次准备发布或拒绝之前附着。`owner-disposed` 是调用者、技术根，以及发布前的分配所有者或发布后的进程内 Worker 被销毁。`teardown` 是服务销毁或替换。`admitted`、`admission-unflushed` 和 `admission-refused` 是 `beginAttempt` 的三种结果。`retry` 是相同的 `prepare`。`effect-established`、`effect-refused` 和 `effect-failed` 结束 `worktree` 或 `activating` 的提供者调用：`effect-refused` 是证明没有子级残留的 Subagent 拒绝，`effect-failed` 是任何 Worktree 拒绝或 Subagent 的 `ACTIVATION_TEARDOWN_FAILED`。`stage-failed` 是回执写入、身份检查或 Ticket 读取失败。`settle` 和 `dispose` 是句柄方法。`producers-settled` 表示每个生产者都报告了结果及资源释放；单元格展示成功的报告，`cancel` 意图会把 `failed` 以外的任何结果变为 `cancelled`。`cleanup-failed` 表示所有结果均已知，但某项释放未在截止时间内确认或被拒绝。`stop-failed` 是在所有结果已知之前结算超时、取消请求抛出异常或激活结果被拒绝。`cancel-failed` 是抛出异常的取消请求，包括 `startJob` 信号发出的请求：在停止过程中，该次停止随后应用 `stop-failed` 或 `cleanup-failed`；在停止之外，生产者保留其预留，直到它自身的结算信号到达，该失败会连同尝试一起记录到日志。`reconciled` 是另一次 `prepare` 发现该尝试已由宿主调用者结算。

单元格：`—` 保持阶段，`✗` 以 `TICKET_ATTEMPT_STATE` 拒绝，`aborted:`、`natural:`、`cancel:` 或 `captured:` 指明结果适用的当前阶段变体；`captured` 变体以捕获结果 `succeeded` 展示。

<!-- BEGIN GENERATED ticket-attempt-lifecycle -->
| State | `caller-abort` | `owner-disposed` | `teardown` | `admitted` | `admission-unflushed` | `admission-refused` | `retry` | `worktree-start` | `activation-start` | `effect-established` | `effect-refused` | `effect-failed` | `stage-failed` | `publish` | `settle` | `dispose` | `producers-settled` | `cleanup-failed` | `stop-failed` | `cancel-failed` | `reconciled` |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `admitting` | admitting(aborted); aborted: — | admitting(aborted); aborted: — | admitting(aborted); aborted: — | preparing; aborted: handed(cancelled) | unflushed; aborted: handed(cancelled) | released | — | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `unflushed` | — | handed(cancelled) | handed(cancelled) | ✗ | ✗ | ✗ | admitting | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `preparing` | preparing(aborted); aborted: — | preparing(aborted); aborted: — | preparing(aborted); aborted: — | ✗ | ✗ | ✗ | — | worktree; aborted: handed(cancelled) | activating; aborted: handed(cancelled) | ✗ | ✗ | ✗ | handed(failed); aborted: handed(cancelled) | running; aborted: handed(cancelled) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `worktree` | worktree(aborted); aborted: — | worktree(aborted); aborted: — | worktree(aborted); aborted: — | ✗ | ✗ | ✗ | — | ✗ | ✗ | preparing; aborted: handed(cancelled) | ✗ | uncertain | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `activating` | activating(aborted); aborted: — | activating(aborted); aborted: — | activating(aborted); aborted: — | ✗ | ✗ | ✗ | — | ✗ | ✗ | launched; aborted: stopping(cancel) | handed(failed); aborted: handed(cancelled) | uncertain | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `launched` | launched(aborted); aborted: — | launched(aborted); aborted: — | launched(aborted); aborted: — | ✗ | ✗ | ✗ | — | ✗ | ✗ | ✗ | ✗ | ✗ | stopping(cancel) | running; aborted: stopping(cancel) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `running` | — | stopping(cancel) | stopping(cancel) | ✗ | ✗ | ✗ | — | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | stopping(natural) | stopping(cancel) | ✗ | ✗ | ✗ | — | ✗ |
| `stopping` | — | natural: stopping(cancel); cancel: —; captured: stopping(cancel; succeeded) | natural: stopping(cancel); cancel: —; captured: stopping(cancel; succeeded) | ✗ | ✗ | ✗ | — | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | — | natural: stopping(cancel); cancel: —; captured: stopping(cancel; succeeded) | natural: handed(succeeded); cancel: handed(cancelled); captured: handed(succeeded) | natural: unknown(natural; succeeded); cancel: unknown(cancel; cancelled); captured: unknown(natural; succeeded) | natural: unknown(natural); cancel: unknown(cancel); captured: unknown(natural; succeeded) | — | ✗ |
| `unknown` | — | — | natural: stopping(cancel); cancel: stopping(cancel); captured: stopping(cancel; succeeded) | ✗ | ✗ | ✗ | — | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | natural: stopping(natural); cancel: stopping(cancel); captured: stopping(natural; succeeded) | natural: stopping(cancel); cancel: stopping(cancel); captured: stopping(cancel; succeeded) | ✗ | ✗ | ✗ | — | released |
| `uncertain` | — | — | — | ✗ | ✗ | ✗ | — | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | released |
| `handed` | — | — | — | ✗ | ✗ | ✗ | — | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | — | — | ✗ | ✗ | ✗ | — | ✗ |
| `released` | — | — | — | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | — | ✗ |
<!-- END GENERATED ticket-attempt-lifecycle -->

进入动作：变为已中止会中止每个提供者调用都观察的准备生命周期。进入 `stopping` 会启动一次停止。每次进入 `cancel` 意图都会向每个尚未结束的生产者发送新的取消请求，因此取消请求失败后再次 `dispose()` 会重新请求，已结束的生产者则无需请求即可被观察。一个 `settlementTimeoutMs` 截止时间限定整个停止：等待中的 Job 准入、对生产者的观察、未知状态记录的写入，以及等待账本使已移交的结果持久化。截止时仍在进行的账本写入会使调用以 `TICKET_SETTLEMENT_PENDING` 拒绝；因为 `handed` 是终态，不会应用 `stop-failed`。观察失败或超时时，先应用 `stop-failed` 或 `cleanup-failed`，再写入一次 `stop-unknown` 或 `cleanup-unknown`；截止时仍在进行的写入会继续，其失败会被记录到日志。进入 `handed` 会在任何可能失败的写入之前，把结果和已知工作区回执同步交给账本；进入 `handed` 或 `released` 会释放执行预留以及注册在根上下文中的预留。因此，已发布尝试的 `prepare` 只有在停止和账本交接完成后才会拒绝，中止后不会留下运行中的句柄。

`TicketService` 中的结算账本把 `settled` 快照写入存活根。根已关闭时返回 `TICKET_SETTLEMENT_PENDING`，恢复该根会重放写入。刷新失败时，下一次结算重试或该根上的 Ticket 写入会重新刷新，清理时还会最后尝试一次。若根的存储 Session 被删除，该结果随之丢弃。只有使结算持久化的刷新，或在账本已持有结果后删除根的存储 Session，才会释放范围预留和账本条目。`failed` 和 `cancelled` 释放分配；`succeeded` 保持分配开放，以便提交结果报告。持久化为 `unknown` 的尝试由宿主调用者通过 `settleAttempt` 结算。

生命周期只采信各生产者所保证的信号。注册表记录、记录的终态以及 Agent 销毁都不能证明生产者的任何状态，从不被当作结算。

| 信号 | Job | Subagent 激活 | Worktree | 进程内 Worker |
|---|---|---|---|---|
| 启动已接受 | Job 回执写入已刷新；随后 Ticket 调用生产者的启动 | `startActivation` 已兑现 | `create` 已兑现 | 发布时所分配的 Worker 存活 |
| 启动被拒，无残留 | 回执写入失败，或启动在返回 hooks 前抛出异常 | `ACTIVATION_TEARDOWN_FAILED` 以外的拒绝 | 无 | — |
| 启动被拒，生产者可能残留 | — | `ACTIVATION_TEARDOWN_FAILED` | 任何拒绝 | — |
| 结果可用 | `hooks.done` 已完成 | `result` 已完成；它可能先于释放 | — | `whenIdle()` 已兑现 |
| 资源已释放 | `hooks.done` 已完成，Jobs 契约将其排在释放之后 | `dispose()` 已兑现 | 检出按设计保留在工作区回执中 | `whenIdle()` 已兑现 |
| 取消已送达 | `hooks.cancel` 已返回；记录处于运行或停止中时经由 `jobs.kill` | 已调用 `dispose()` | 准备信号已中止 | `cancel()` 已返回 |
| 取消失败 | `hooks.cancel` 或 `jobs.kill` 抛出异常 | `dispose()` 被拒绝 | — | `cancel()` 抛出异常 |
| 取消已确认 | `hooks.done` 已完成 | `dispose()` 已兑现 | `create` 已完成 | `whenIdle()` 已兑现 |
| 记录已移除 | 不能证明任何事：所有者清理会丢弃取消抛出异常的记录，而生产者可能仍在运行 | 不能证明任何事 | — | Agent 销毁不能证明任何事 |

替换时等待而不接管。新的 Ticket 或执行服务从不接管更早一代的运行；它只通过注册在根上下文中的预留排斥该运行的范围，直到生产者自身的信号证明它们已停止，或宿主结算该尝试。每个已准入的尝试无论使用哪种工作区都会注册这样的预留，因此在替换期间关闭、之后再恢复的根不会把仍有存活生产者的尝试恢复为 `cancelled`，而是让它保持未结算。

Ticket 命令通过 `attemptAdmitsCommand` 读取持久化尝试状态。`end-ticket` 指 `complete`、`fail` 和 `cancel`，适用于该 Ticket 的每个尝试；其他命令适用于分配的当前尝试。

<!-- BEGIN GENERATED ticket-attempt-commands -->
| Attempt status | `end-ticket` | `release` | `report-progress` | `report-failure` | `report-result` |
|---|---|---|---|---|---|
| `preparing` | ✗ | ✗ | allowed | allowed | allowed |
| `running` | ✗ | ✗ | allowed | allowed | allowed |
| `stopping` | ✗ | ✗ | allowed | allowed | allowed |
| `unknown` | ✗ | ✗ | allowed | allowed | allowed |
| `settled:succeeded` | allowed | allowed | ✗ | ✗ | allowed |
| `settled:failed` | allowed | allowed | ✗ | ✗ | ✗ |
| `settled:cancelled` | allowed | allowed | ✗ | ✗ | ✗ |
<!-- END GENERATED ticket-attempt-commands -->

重启后，若某个尝试的保留执行操作表明它由本宿主家族准入，本宿主中没有所有者持有它（既不在本 Ticket 服务的账本中，也没有任一代执行服务在根上下文中注册的预留），且它在进程内运行并处于 `preparing`、`running` 或 `stopping`，或在任意执行位置仍处于 `preparing`（工作区阶段之前不会启动任何生产者），则恢复的根会将其结算为 `cancelled`。Ticket 激活时已存活的根留给先前的所有者。手动尝试，以及已过工作区阶段的专用进程或远程尝试保持预留，直到宿主调用者结算它们。

Ticket 服务独立于 Fusion、Agent Teams、Worktree、Jobs、UI、轮询和通用 Subagent 创建。可选执行适配器组合现有 Jobs、Worktree 和 Subagent 提供者，而 Ticket 保留分配和交接的持久化语义。

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
- Ticket 快照在准入更多状态前为未知状态、最小结算记录和最小 Ticket 取消摘要预留字节容量。尝试数量使用 `maxReports`；操作数量由快照字节数而非报告数量限制。`ticket-execution:` 操作 id 前缀保留给已准入的执行事实。操作指纹使用 SHA-256；保留的 JSON 指纹仍可读取。已结算尝试会将带标签的操作记录压缩为一条保留已退役 id 及其指纹的结算记录；重放保留这些拒绝规则，结算重试保留指纹和持久化检查。在保留指纹之前写入的结算记录只有 id，因此对同一尝试重试其中的操作时，无论参数如何都会得到确认。历史无标签操作、报告、问题和关注项不会压缩。
- 损坏根若没有可恢复的 Ticket 执行位置，就无法预留可识别的工作区；恢复警告要求在恢复该根之前修复。已知预留仍被保留。根关闭后，必须先恢复才能持久化结算；在此之前结果只保存在内存中，因此若宿主先退出，进程内尝试会恢复为 `cancelled`，其他执行位置保持预留。
- 注册在根上下文中、其生产者无法确认释放的预留（例如清理失败的激活或回滚失败的 Subagent 启动），只有在宿主结算其尝试时才会释放。Subagent 管理器会在排空和父级释放时重试释放被拒绝启动的执行，但该拒绝不返回激活，因此 Ticket 无法观察到这次重试。若其根 Session 日志已被删除，没有宿主能结算它，因此它会一直保留到宿主退出。
- 若尝试的未知状态记录因根已关闭而无法写入，在本宿主中更早一代服务的生产者仍在运行期间，它会保持最后的持久状态（例如 `running`）；之后的服务代不会改写它。恢复该根时会把该尝试留给生产者；在生产者自身的信号释放预留之后，第一次恢复会将其恢复为 `cancelled`，除非宿主已先行结算。
- 激活管理器会记住失败的释放，因此之后对该激活调用 `dispose()` 会返回同一拒绝，而不会重试释放；该尝试保持 `unknown`，直到宿主以 `settleAttempt` 结算。
- 激活后的第一次共享工作区准入会读取每个存储根日志一次；在有紧凑的预留索引之前，开销随存储历史增长。
- 注入 `tickets` 的服务会在 `ctx.tickets` 重新加载时一同卸载。在 [Workstream profile](../workstream-profile/README.zh.md#known-limitations-and-deferred-work) 中，这会卸载 `workstreams`，其关闭过程会排空每个成员并中止每个运行中的成员本轮。
- Ticket 位于一个 Session 日志中。跨 Session 复制和来源接入由适配器负责。

<a id="dev-note"></a>
### 开发备注

此包处于实验阶段，没有稳定性承诺。Session 事件是权威来源，投影检查点只用于加速重放。
