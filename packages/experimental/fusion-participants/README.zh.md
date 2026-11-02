---
description: "准备保留的 Fusion 参与者上下文并恢复不可变成员关系，不启动模型工作。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-fusion-participants

[English](README.md) | 中文

## 概述

在发布停驻的 Agent 之前准备持久化的参与者上下文。任务在 Agent 分离后继续保留根名册和原始写入句柄，恢复时沿用原身份与已记录的路由。显式角色链接共享上下文，独立角色保留独立历史。准备和发布不会启动轮次或领取排队输入。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

显式挂载此主机服务，并同时提供 `agentLoop`、`agents`、`sessions`、`sessionPersistence`、`sessionProjections`、`fusionConfig` 和 `agentPresets`。本服务没有配置字段。主机调用 `ctx.fusionParticipants.prepare(selectionId)` 或 `recover(rootSessionId)`，并持有返回的 `PreparedParticipants` 能力直到任务释放。`adopt(role)` 返回停驻的 Agent；释放该 Agent 后，其 Session 与写入句柄仍可再次采用。释放任务先取消并排空其工作，再移除路由并关闭写入句柄。发起调用的作用域仅负责取消和等待；Fusion 所有者独立于调用者保留全部租约与组合。

`PreparedParticipants.execution` 只返回深度不可变的权限事实。准备和恢复会持久化新的关闭状态实例；历史授权不赋予执行权限。默认组合不安装执行签发者或效果适配器，因此执行保持 `integration-missing` 阻塞。快照不暴露运行、授权、控制器或模型可执行回调。

可信主机显式调用 `registerExecutionHost(task, provider)`，并传入准备操作返回的精确对象。一个提供方和声明调用方的 fiber 在整个实例期间拥有该连接；相同重试共享等待结果，对象副本、替换提供方或替换 fiber 均被拒绝。空打开操作释放预留后，注册会重新固定精确保留的根写入器及按参与者身份排序的写入器。调用方撤回会关闭准入并等待清理。主机仅在进程内持有不透明的签发者、控制器、运行与暂存尝试对象；标识、快照、属性副本及代理均无法重建这些能力。

先授权变更所有权，再绑定对应运行。`reserve(run, operation)` 同步返回新逻辑请求令牌；注册和释放重试必须保留该令牌。`register(attempt)` 固定休眠暂存身份的分配等待结果，不执行准备、载荷入口或推理。准备操作分配资源之前，必须已经存在独立的取消与清理锚点。`release(attempt)` 固定准备、原始 Session 的开始记录持久化、所有者同步调用、独立清理及原始 Session 的结果持久化等待结果。提供方完成异步检查后返回惰性的同步调用叶；所有者重新检查当前主机分类、精确身份、代次、撤销状态及所有写入器寿命，消耗一次性调度资格，然后无中间等待地进入该叶。入口抛出异常也会消耗调度资格，并使结果保持未知。取消暂存请求不需要调用释放；后继授权保留任务寿命预留，并等待已接纳的清理与结果持久化。

私有执行所有者同步预留提供方的精确写入器，在调度前持久化来源 Session 的开始记录，并在最后的同步调用位置检查当前运行、代次、策略与写入器准入。撤销立即关闭准入，然后持久化撤销事实，等待已接纳工作、清理和结果持久化，之后才允许后继授权。结果未知或持久化失败时保留写入所有权，并拒绝成功释放。恢复仅折叠必读日志事实，不重放效果；独立协调记录证据，不伪造生产方结算。任务释放在保留写入器释放前等待执行与现有交付工作。

持久化的 `openingId` 是任务每次打开时的新随机标识，不是操作系统启动身份。带启动身份的约束标识和真实效果适配器仍由下游实现。已知的部分初始化失败会在拒绝前回滚写入器预留。释放在调用回调前固定等待结果，并移除生命周期监听器；仍保留执行写入器时，传输失败会阻止释放。协调失败会保留其预留和未知的生产方结果。

执行所有者在构造时为其精确根条目和参与者条目注册撤出义务。撤出同步停止执行和交付准入，并在释放预留前等待它们的终止工作。交付协调在执行所有者构造前开始；该较早区间中的撤出尚未通过验证，仍可能接受交付预留。

准备失败时，`ParticipantPreparationError.rootSessionId` 保留恢复身份，`cleanup` 标明清理已完成或结果未知。解决失败原因后使用该根身份恢复；再次调用准备会创建另一个任务。已建立的参与者历史缺失或损坏时，恢复被阻止，不会分配替代上下文。所有权与成员记录缺失、格式无效或重复时也会拒绝恢复；必读的生命周期记录使旧版标准读取器在激活前拒绝受管理历史。

`PreparedParticipants.delivery` 将类型化用户文本或已认证的活跃同伴文本投递给名册参与者，不收养或唤醒 Agent。在主机入口构造一次 `DeliveryId`，重试复用它。相同重试保留顺序、修订与 MessageId；内容、来源或路由变化会冲突。所有普通文本（包括 `ok`）在传输完成后仍阻塞且未分类。`snapshot()` 返回不可变输入事实与同步待处理预留，不执行 I/O。

根意图持久化先于接收方接受和收件箱插入。回执要求验证接收方与根完成记录的持久化屏障；只承诺一个逻辑指令，不承诺推理或效果结算。`reconcile()` 使用保留的文本和来源元数据修复仅有接受记录的前缀，不重新插入已消费或取消的消息。恢复在发布前协调，收养共享同一任务顺序。`DeliveryBlockedError` 保留原始身份供协调使用。调用前已中止的信号不会接纳输入。同步预留后，中止仅以其中止原因拒绝该调用方的等待；任务继续交付（包括排队发送），不影响其他调用方。使用相同 DeliveryId 重试可获取回执；取消不会撤回已预留输入。任务释放取消回执发布，并在关闭写入器前排空传输。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>实现细节 — 点击展开</summary>

根租约先于参与者租约获取，参与者按持久化身份排序。必读且仅用于日志的记录保留不可变名册与成功建立的证据。准备成功之前，每个保留的 Session 都经过持久化服务的同一写入句柄耐久屏障。Agent 通过现有循环工厂采用原始已注册 Session。观察清理的资源作用域捕获构造时的所有者上下文，并将其精确 Cordis 释放器纳入有序清理。待完成操作在调用提供方回调前预留工作边界；回滚与任务释放等待全部已接纳操作停止使用资源。显式循环依赖在直接卸载循环时保留工厂。保留的预设作用域独立于驻留 Agent 延长组合代次的寿命；在读取声明摘要前后比较代次身份，并发替换会阻止准备。

| 源文件 | 职责 |
|---|---|
| [src/index.ts](src/index.ts) | 主机寿命、准备、恢复与组合 |
| [src/roster.ts](src/roster.ts) | 不可变成员与精确绑定解析 |
| [src/state.ts](src/state.ts) | 已验证的根恢复投影 |
| [src/delivery.ts](src/delivery.ts) | 休眠文本准入与协调 |
| [src/delivery-state.ts](src/delivery-state.ts) | 必需投递记录与永久输入身份 |
| [src/execution.ts](src/execution.ts) | 关闭状态的任务权限、写入器预留与效果清理 |
| [src/execution-state.ts](src/execution-state.ts) | 必读执行历史与恢复验证 |
| [src/task-order.ts](src/task-order.ts) | 共享的私有任务顺序 |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Fusion 配置](../../preset/fusion-config/README.zh.md) — 已捕获的角色选择。
- [Agent 循环](../../core/agent-loop/README.zh.md) — 采用保留的 Session。
- [Session 持久化](../../session/session-persistence/README.zh.md) — 写入句柄耐久性。

<a id="model-experience"></a>
## Model Experience

### Parked participant contexts

#### What the model sees

准备和采用不会提交模型输入。`fusion/roster`、`agent/runtime-owner` 与 `fusion/execution-opened` 是必读且仅保留在日志中的事件；续接沿用参与者自己的历史与已选预设组合。

#### Token effect

准备、发布和恢复期间没有推理请求。投递仅将文本排队；激活需要独立授权。

#### KV Cache effect

本包在 Agent 分离后保留上下文谱系，不复制其他参与者的对话。提供方缓存的可用性与淘汰不由本包保证。

## Known Limitations and Deferred Work

- 此可选所有者在拆卸时同步关闭准入，等待待完成的准备与恢复，并在释放保留写入器之前排空全部已发布任务工作。主机、所有者、调用者和循环拆卸使用此排空流程。永不完成的操作使正常拆卸持续等待；强制终止进程仍等同于崩溃。原始 Cordis 释放记录清理失败；观察清理的作用域与任务释放携带保留原因拒绝。
- 公共主机连接依赖协作的主机提供方。它不提供原生约束、作业注册表、QuickJS 运行时、最终确认调度器或成功的未知结果恢复。清理、取消、调用或持久化结果未知时，保留预留并携带原因阻止授权和释放；重试绝不重放载荷。已有的独立效果协调事实不能证明原生清理，公共主机也不暴露恢复操作。暂存分配器抛出异常时无法提供独立清理锚点，因此任务保持阻塞。根拆卸可能在执行撤销或结果持久化之前移除保留写入器的事件路由；由此产生的持久化不确定性会保留所有权并阻止排空成功。
- 产品激活、输入分类与处置、执行授权、约束和最终决策由下游负责。不向模型或客体工具导出激活控制。
- 来源 Session 在结算前分离可能阻止必读结果追加。清理保持阻塞并保留写入器；恢复绝不伪造缺失的生产方记录。
- 恢复需要匹配的预设声明；组合已修改时拒绝准备。本包不保留历史预设目录或插件数据库。
- 主机处理任务释放的拒绝；执行不确定状态会保留任务写入器，直到独立证据支持恢复或进程退出。清理失败使结果保持未知，包括先前直接释放的失败；重复释放保留原因，已释放的任务拒绝接管。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
