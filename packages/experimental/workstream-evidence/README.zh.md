---
description: "不可变的 Workstream 证据版本、写入日志的上下文包，以及对成员变更请求的只读聚合。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-workstream-evidence

[English](README.md) | 中文

## 概述

Workstream Evidence 为一个 Workstream 保存具名证据产物的不可变、经摘要校验的版本。内容存放在 Attachment 中，根 Session 事件日志记录每个版本的引用、摘要、大小和作者。服务注册 `ctx.workstreamEvidence` 和 `workstreamEvidence` Session 投影。它还基于确切版本构建写入日志的上下文包，并报告成员 Session 中的 forge 绑定已记录的变更请求。

## 目录

- [使用本包](#use-this-package)
- [实现原理](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将 `@deepseek-ai/dsh-experimental-workstream-evidence` 与 `@deepseek-ai/dsh-experimental-workstream`、带有可原样存储文件的提供方的 `@deepseek-ai/dsh-attachment`、持久化 Session 存储以及 `@deepseek-ai/dsh-session-projection` 一起挂载。`@deepseek-ai/dsh-experimental-forge-session` 是可选的 peer 依赖。每个方法都接收调用方当前存活的 `Agent`，并通过 `ctx.workstreams.requireMembership` 检查 Workstream 成员关系。

服务提供 `publish`、`get`、`list`、`read`、`readText`、`prepareContext` 和 `aggregateChangeRequests`。

`publish` 把内容保存为 Attachment 文件，并把版本追加到根 Session。新产物的 `expectedVersion` 为 1，已有产物则为下一个版本号；其他值返回 `WORKSTREAM_EVIDENCE_STALE_VERSION`。内容可以是字符串或 `Uint8Array`。产物 id 长 1–200 个字符，且不含 `/`、`\` 或 `..`。操作 id 长 1–200 个字符。使用相同 `operationId`、产物 id、期望版本和内容重试，会返回已存储的版本；任何差异都返回 `WORKSTREAM_EVIDENCE_PAYLOAD_MISMATCH`。版本从不被编辑或删除。

`get` 返回某个版本的元数据；省略 `version` 时返回最新版本。`list` 返回每个产物及其完整版本历史。`read` 以流方式读取 Attachment，并对照记录校验字节长度和 `sha256:` 摘要，不一致或读取失败时返回 `WORKSTREAM_EVIDENCE_CORRUPT`。`readText` 还要求版本大小不超过 `maxToolTextBytes`，且字节是有效的 UTF-8，否则分别返回 `WORKSTREAM_EVIDENCE_LIMIT_EXCEEDED` 或 `WORKSTREAM_EVIDENCE_INVALID_INPUT`。

`prepareContext` 构建供 `ctx.workstreams.sendMessage` 使用的 `WorkstreamContextPacket`。每个请求的产物都需要确切的 `version`，上下文包携带已存储的 `ref` 和 `digest`，而不是路径。产物 id 含 `/`、`\`、`..` 或以 `file:` 开头时，会作为可变或外部链接被拒绝。序列化后的上下文包超过 `maxContextPacketBytes` 时返回 `WORKSTREAM_EVIDENCE_LIMIT_EXCEEDED`。该方法不发送上下文包。

`aggregateChangeRequests` 读取根 Session 和每个活跃成员的 `forgeSession.changeRequests`，并按 URL 对绑定分组。每个条目为每个 Session 列出一项贡献，包含其来源和最近一次轮询更新，根 Session 在先。它从不写入 forge。当 forge 服务未挂载，或某个 Session 未加载时，`complete` 为 `false`，并在 `diagnostics` 中给出说明。

配置字段均为正的安全整数：`maxBytesPerArtifact`（10 MiB）、`maxArtifacts`（256）、`maxVersionsPerArtifact`（64）、`maxTotalBytes`（100 MiB）、`maxContextPacketBytes`（65536）和 `maxToolTextBytes`（65536）。超出发布限制时返回 `WORKSTREAM_EVIDENCE_LIMIT_EXCEEDED`。

错误是 `WorkstreamEvidenceError`，其 code 为 `WORKSTREAM_EVIDENCE_NOT_FOUND`、`WORKSTREAM_EVIDENCE_UNAUTHORIZED`、`WORKSTREAM_EVIDENCE_STALE_VERSION`、`WORKSTREAM_EVIDENCE_PAYLOAD_MISMATCH`、`WORKSTREAM_EVIDENCE_LIMIT_EXCEEDED`、`WORKSTREAM_EVIDENCE_CORRUPT`、`WORKSTREAM_EVIDENCE_INVALID_INPUT` 或 `WORKSTREAM_EVIDENCE_DISPOSED`。

`workstreamEvidence` [Session 投影](../../session/session-projection/README.zh.md) 是浏览器安全的读取路径，对没有证据的 Session 其值为 `null`。浏览器安全类型从 `@deepseek-ai/dsh-experimental-workstream-evidence/client` 导入。

<a id="understand-the-implementation"></a>
## 实现原理

包由五个小层次组成：

- [`src/types.ts`](src/types.ts) 负责版本、产物、快照、请求、变更请求和配置类型，以及 `plugin:workstream-evidence/state` 记录和 `workstreamEvidence` 投影的声明。
- [`src/projection.ts`](src/projection.ts) 用严格的 schema 验证每条 `plugin:workstream-evidence/state` 记录，忽略属于其他所有者的记录，并拒绝版本间隙。
- [`src/index.ts`](src/index.ts) 按根 Session 串行化发布，执行限制，通过 `ctx.attachments` 保存内容，以 `version: 1` 把完整快照作为插件记录追加到根 Session 并刷新，同时提供 `ctx.workstreamEvidence`。
- [`src/forge-adapter.ts`](src/forge-adapter.ts) 基于 `ctx.get('forgeSession')` 实现 `aggregateChangeRequests`。
- [`src/tools.ts`](src/tools.ts) 注册可选的 `workstream_evidence_*` 工具。

不可变性来自仅追加的记录和读取时的摘要校验；Attachment 存储本身并不强制这一点。发布时先保存 Attachment，再追加记录，因此两者之间发生失败可能留下未被引用的 Attachment。

<a id="model-experience"></a>
## 模型体验

### 可选的 Workstream Evidence 工具

#### 模型看到的内容

`WorkstreamEvidenceTools` 注册 `workstream_evidence_publish`、`workstream_evidence_list`、`workstream_evidence_read` 和 `workstream_evidence_aggregate_prs`。每个工具都接收 `root_session_id`。发布工具接收 UTF-8 的 `text`、`artifact_id`、`operation_id`、`expected_version` 和可选的 `name`。读取工具接收 `artifact_id` 和可选的 `version`，返回元数据和文本。结果是服务返回值的 JSON，渲染为一个文本块。这些工具不在生成的工具目录中，因为没有任何已发布的 profile 注册它们。没有对应 `prepareContext` 的工具。

#### Token 影响

`WorkstreamEvidenceTools` 挂载期间，每个已注册工具的定义都会增加 schema token。`workstream_evidence_list` 返回每个版本记录，`workstream_evidence_read` 最多返回 `maxToolTextBytes` 的文本。

#### KV 缓存影响

注册或移除这些工具会改变工具列表，可能使暴露它们的 Session 的已缓存请求前缀被替换。工具结果产生之后仅追加增长。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 此包没有浏览器 UI。`workstreamEvidence` 投影是唯一面向浏览器的接口。
- 证据只能通过 `publish` 进入。此包不从宿主工作区捕获文件，工具只接受 UTF-8 文本；二进制内容需要使用服务方法。
- Forge 聚合是只读的。它只报告已加载 Session 中已经记录的绑定；对未加载的 Session，它设置 `complete: false` 并给出诊断，forge 服务未挂载时返回空结果。
- 版本从不删除或压缩，因此 Workstream 达到 `maxArtifacts`、`maxVersionsPerArtifact` 或 `maxTotalBytes` 后会拒绝后续发布。
- 证据属于一个 Workstream 的根 Session。此包不在 Workstream 之间复制证据。
- Attachment 保存成功后追加失败，可能留下未被引用的 Attachment；此包不回收它。

<a id="dev-note"></a>
### 开发备注

此包处于实验阶段，没有稳定性承诺。Session 事件是权威来源，投影检查点只用于加速重放。
