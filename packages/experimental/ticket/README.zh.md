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

服务提供 `create`、`assign`、`claim`、`release`、`report`、`ask`、`answer`、`closeQuestion`、`attention`、`acknowledgeAttention`、`resolveAttention`、`block`、`handoff`、`complete`、`fail` 和 `cancel`。修改命令携带 `expectedRevision`；过期版本返回 `TICKET_STALE_REVISION`，不会覆盖更新后的状态。Worker 是执行适配器提供的直接 Session 身份。当前协调者可以回答未解决的问题，并确认或解决关注项；问题作者也可关闭自己未解决或已回答的问题。确认关注项不会解除阻塞。Worker 的进度、认领和释放操作会保留未解决的问题及关注项；解除最后一项阻塞后，根据分配状态重新计算就绪状态。已结束或已释放的分配拒绝报告；执行成功结算后，分配仍保持开放，以便提交结果报告。 规格编辑会重新开放没有尝试历史的已完成贡献，供模型提交新报告，同时保留旧报告历史。有尝试历史的分配需要宿主准入新尝试；旧式认领不能重新开放它们。独占写分配必须使用带工作区身份的尝试，而不能使用旧式认领。候选提交若引用没有当前结果报告的分配，会返回包含分配身份的 `TICKET_ACCEPTANCE`。必需子 Ticket 约束验收；未完成、失败或取消的子 Ticket 不会阻止父 Ticket 取消或失败。

当模型需要通过 `ticket_*` 命令协调时挂载 `TicketTools`。当分配需要共享工作区、隔离 worktree或自有后台任务时，挂载 `TicketExecutionService` 并提供 Jobs 和 Worktree 服务。执行适配器准入持久化尝试，检查直接 Worker 身份，并获得绑定到尝试的记录器，将执行事实与所有 Ticket 命令串行化，无需调用者 CAS。准备操作必须匹配当前发起 Agent（若存在）。记录器在协调员交接或准备 Agent 销毁后仍可使用。启动生产者前，它保持运行时身份不变，并把每个 job id 追加到回执中。`prepare` 的信号只取消准备过程，句柄发布后不再保留；`startJob` 的信号会一直附着在其 Job 上，直到该生产者结算或句柄被清理。失败 Job 优先于已取消 Job，二者均阻止成功。销毁先请求取消，再执行持久化写入，即使 Agent 清理已删除 Job 记录，也等待保留的生产者承诺。等待中或超时的自然结算可升级为销毁。在生产者启动前取消或关闭会将尝试结算为已取消，并保留已知工作区回执。资源创建结果不确定时仍记为未知。所有者释放回调不会自动重试失败的停止；显式释放和清理可以重试。生产者结果确定后，由 Ticket 负责结算直至其持久化，详见[尝试状态机](#attempt-state-machine)；若句柄的根 Session 已关闭，销毁会以可重试的 `TICKET_SETTLEMENT_PENDING` 拒绝，恢复该根后会写入结算。在任一准备阶段（包括准入刷新期间）销毁调用者、Worker 或根时，不会发布句柄，尝试结束为已取消，`prepare` 以 `TICKET_AUTHORITY` 拒绝。若准入本身的刷新失败，相同的 `prepare` 重试会重新刷新并继续准备；若没有重试，上述销毁或清理会将尝试结束为已取消。重复准备已结算尝试返回 `TICKET_ATTEMPT_STATE`。

为某个 Session 负责协调的包通过 `registerCoordinatorAuthority(authority)` 注册，并获得返回的释放函数。`create` 在该 Session 的命令队列内询问每个授权方，且与读取 Session 状态、追加 Ticket 处于同一个同步步骤。授权方收到请求的协调者（`CreateTicketRequest.coordinatorId`，缺省为 Session id），并可返回替代者；第一个替代者生效，因此协调权变化期间创建的 Ticket 总是记录追加时授权方决定的协调者。授权方抛出 `TicketError` 时，创建以该错误原样失败，例如仍在加载的授权方返回可重试的 `TICKET_COORDINATOR_UNAVAILABLE`；其他异常返回带有原始原因的 `TICKET_RECOVERY_FAILED`。两者都不追加任何内容。若协调者不是已注册且存活的 Agent，则返回 `TICKET_AUTHORITY`，错误会写明该协调者、是否由授权方选定，以及补救方法：恢复该 Agent，或把协调权交还给 Session 所有者。

[Session 投影](../../session/session-projection/README.zh.md) 是浏览器安全的读取路径。每个 `ticket/state` 事件包含完整的变更后值，因此打开 Session 或重放事件会得到相同状态，并拒绝格式错误或版本不连续的记录。命令准入和重放共用语义验证；无效命令不会追加事件。提议状态的 Ticket 不能直接完成。持久化刷新可能在追加后失败，重试前应读取当前版本。幂等的尝试操作重试会再次刷新 Session，然后才报告成功，包括已被结算压缩进尝试墓碑记录的操作的重试。墓碑记录保留每个已退役操作的指纹，因此参数不同的压缩操作重试返回 `TICKET_OPERATION_CONFLICT`，将这类 id 用于另一个尝试则返回 `TICKET_ATTEMPT_STATE`。 旧版 v1 报告投影到合成的初始规格，因此保留的结果可以进入 v2 候选而无需改写旧事件。

工作范围规范化以斜杠分隔的相对路径，折叠 `.` 和 `..`，并拒绝工作区逃逸、绝对路径、驱动器前缀和反斜杠。分配范围必须位于声明的 Ticket 范围内，且不能从读权限提升为写权限；未声明范围的 Ticket 不限制分配声明。尝试准入会在同一共享执行环境中原子排斥重叠写范围，只要任一声明为独占。范围检查和追加同步执行；无关根无需等待另一根的刷新。预留在根 Session 关闭后仍保留，并在停止、未知状态或结算刷新失败期间持续持有。激活不读取任何存储日志。第一次共享工作区准入会列出存储，并只折叠每个未存活存储根的 `ticket/state` 事件，不恢复生产者；之后的准入复用这次扫描。列出失败或存储根无法读取时，共享工作区准入以写明原因或根的 `TICKET_RECOVERY_FAILED` 拒绝，下一次准入会重试。根的存储 Session 已不存在时，其预留会被释放，除非本宿主中仍有所有者在等待其生产者的结果；删除日志并不代表生产者已结算，因此该所有者的预留会在其把结果交给账本后才释放。存活根重放失败时仅针对该根报告并保留其已知范围；无关范围仍可使用。隔离 worktree和不同执行环境相互独立；范围不会限制文件系统访问。

<a id="understand-the-implementation"></a>
## 实现原理

包由三个层次组成：

- [`src/types.ts`](src/types.ts) 负责品牌化 id、JSON 兼容快照、请求值、浏览器投影类型和持久化事件声明。
- [`src/projection.ts`](src/projection.ts) 同步验证并折叠 `ticket/state` 事件，拒绝版本间隙、不可变身份变化、嵌套 id 重复和非法生命周期转换。
- [`src/index.ts`](src/index.ts) 按 Session 串行化命令，执行权限和数量限制，通过 `ctx.sessions` 写入完整快照并提供 `ctx.tickets` 服务接口。

<a id="attempt-state-machine"></a>
### 尝试状态机

每个已准入尝试在任一时刻只有一个所有者；每次写入都按 id 指定根 Session，并在写入执行时解析它。

| 状态 | 所有者 | 何时结束 |
|---|---|---|
| `preparing` | `TicketExecutionService` 预留及其准备生命周期 | 准入时随尝试一并记录保留的执行所有权操作。记录工作区后进入 `running`。生产者启动前的确定失败或取消，会在任何其他写入之前把 `failed` 或 `cancelled` 连同已知工作区回执交给结算账本。worktree 或激活结果不确定时记录 `unknown`。销毁调用者、Worker 或根，或执行清理，会在任一阶段中止准备生命周期，不发布句柄，并把 `cancelled` 交给账本。若准入刷新失败，相同重试会继续准备；若没有重试，上述销毁或清理会把 `cancelled` 交给账本。 |
| `running` | `TicketExecutionService` 句柄 | `settle()`、`dispose()`、所有者销毁或清理观察所有生产者，并把结果交给账本；生产者未在 `settlementTimeoutMs` 内结算时记录 `unknown`。 |
| `unknown` | 宿主对账 | 宿主调用者通过 `settleAttempt` 记录观察到的结果。 |
| 结果已交给账本 | `TicketService` 结算账本 | 账本同步接收结果，并把 `settled` 快照追加到存活根。根已关闭时返回 `TICKET_SETTLEMENT_PENDING`，恢复该根会重放写入。刷新失败时，下一次结算重试或该根上的 Ticket 写入会重新刷新，清理时还会最后尝试一次。若根的存储 Session 被删除，该结果随之丢弃。 |
| `settled` | 无 | 终态。`failed` 和 `cancelled` 释放分配；`succeeded` 保持分配开放，以便提交结果报告。只有使结算持久化的刷新，或在账本已持有结果后删除根的存储 Session，才会释放范围预留和账本条目。 |

重启后，若某个尝试的保留执行操作表明它由本宿主家族准入，本宿主中没有所有者持有它，且它在进程内运行并处于 `preparing`、`running` 或 `stopping`，或在任意执行位置仍处于 `preparing`（工作区阶段之前不会启动任何生产者），则恢复的根会将其结算为 `cancelled`。Ticket 激活时已存活的根留给先前的所有者。手动尝试，以及已过工作区阶段的专用进程或远程尝试保持预留，直到宿主调用者结算它们。

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
- 激活后的第一次共享工作区准入会读取每个存储根日志一次；在有紧凑的预留索引之前，开销随存储历史增长。
- Ticket 位于一个 Session 日志中。跨 Session 复制和来源接入由适配器负责。

<a id="dev-note"></a>
### 开发备注

此包处于实验阶段，没有稳定性承诺。Session 事件是权威来源，投影检查点只用于加速重放。
