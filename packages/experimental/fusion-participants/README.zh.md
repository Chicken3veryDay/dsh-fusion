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

显式挂载此主机服务，并同时提供 `agents`、`sessionPersistence`、`sessionProjections`、`fusionConfig` 和 `agentPresets`。本服务没有配置字段。主机调用 `ctx.fusionParticipants.prepare(selectionId)` 或 `recover(rootSessionId)`，并持有返回的 `PreparedParticipants` 能力直到任务释放。`adopt(role)` 返回停驻的 Agent；释放该 Agent 后，其 Session 与写入句柄仍可再次采用。释放任务会等待 Agent 停止、移除路由并关闭写入句柄。

准备失败时，`ParticipantPreparationError.rootSessionId` 保留恢复身份，`cleanup` 标明清理已完成或结果未知。解决失败原因后使用该根身份恢复；再次调用准备会创建另一个任务。已建立的参与者历史缺失或损坏时，恢复被阻止，不会分配替代上下文。所有权与成员记录缺失、格式无效或重复时也会拒绝恢复；必读的生命周期记录使旧版标准读取器在激活前拒绝受管理历史。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>实现细节 — 点击展开</summary>

根租约先于参与者租约获取，参与者按持久化身份排序。必读且仅用于日志的记录保留不可变名册与成功建立的证据。准备成功之前，每个保留的 Session 都经过持久化服务的同一写入句柄耐久屏障。Agent 通过现有循环工厂采用原始已注册 Session。保留的预设作用域独立于驻留 Agent 延长组合代次的寿命；在读取声明摘要前后比较代次身份，并发替换会阻止准备。

| 源文件 | 职责 |
|---|---|
| [src/index.ts](src/index.ts) | 主机寿命、准备、恢复与组合 |
| [src/roster.ts](src/roster.ts) | 不可变成员与精确绑定解析 |
| [src/state.ts](src/state.ts) | 已验证的根恢复投影 |

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

准备和采用不会提交模型输入。`fusion/roster` 与 `agent/runtime-owner` 事件仅保留在日志中；续接沿用参与者自己的历史与已选预设组合。

#### Token effect

准备、发布和恢复期间没有推理请求。后续激活与投递需要独立授权。

#### KV Cache effect

本包在 Agent 分离后保留上下文谱系，不复制其他参与者的对话。提供方缓存的可用性与淘汰不由本包保证。

## Known Limitations and Deferred Work

- 产品激活、输入投递与去重、执行授权、约束和最终决策由下游负责。不向模型或客体工具导出激活控制。
- 恢复需要匹配的预设声明；组合已修改时拒绝准备。本包不保留历史预设目录或插件数据库。
- 每个保留的 Agent、子插件、组合作用域和写入句柄均完成清理后，由主机处理任务释放的拒绝。清理失败使结果保持未知，包括先前直接释放的失败；重复释放保留原因，已释放的任务拒绝接管。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
