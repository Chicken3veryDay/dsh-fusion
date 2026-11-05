---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-04-ticket-v2-workstream

[English](2026-11-04-ticket-v2-workstream.md) | 中文

## 概述

新增实验性 ticket/state 载荷的版本 2、用户、开发者、收件箱拼接和标题请求消息上的 workstream-message 归属类型，以及新的 workstream/state 事件根。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-04-ticket-v2-workstream
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-01-fusion-dormant-delivery"
    after: "b13a808c5e495e918e8d16788b526b58fd733f6741d6d5a893c86842e95cb3bd"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-01-fusion-dormant-delivery"
    after: "d3624bfb4e0fe612cc6489e0e4237f84ee183f9d6dd013660218df9bfb8a063e"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-01-fusion-dormant-delivery"
    after: "bf10bc3133a22a4b9b1c0f081a41cb496726648c1f3b607ce317fed88aecdeaa"
    decision: same-version
  - root: "event:ticket/state"
    previous: "2026-11-03-ticket-state"
    after: "91ba8fa73daf7294d778944a6e02c9ab08f817b159d14395168df1c23b80a2b6"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-01-fusion-dormant-delivery"
    after: "22061fa35d6cd487aef34aa910f8b5f114f63d912c27623c556d63872a98b427"
    decision: same-version
  - root: "event:workstream/state"
    previous: null
    after: "e92da1a786b4ec10310e40ac99c319a93327b329651452d40be0e94d3f496d3d"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

Ticket：ticket/state 仍是由 data.version 区分的单一事件类型。版本 1 分支保持原有形状，仅报告快照新增可选的 specRevision 和 attemptId；版本 2 增加 specification、attempts、candidates、checks、operations、missionPlans 和分配的 contribution。Ticket 包只存在于此分支，因此没有已发布日志含有任一版本。投影同时解码两者：版本 1 以空的 specification 列表和 required/advisory 贡献默认值升级，同一 ticket 在版本 2 事件之后出现版本 1 事件时，投影以“Ticket event version cannot downgrade”失败（packages/experimental/ticket/src/projection.ts 的 applyProjectionEvent 和 upgradeLegacy）。Workstream 消息来源：workstream-message 是可合并扩展的 MessageSourceMap 中新增的、由生产者拥有的类型（packages/experimental/workstream/src/types.ts）。它未标注 @persistenceAttribution，因此本记录即为显式的 same-version 评审。旧读取方：原生来源准入接受除已退役的 'plugin' 包装之外的任何非空字符串类型（packages/session/session-format-v3-to-v4/src/message-sources.ts），且 JSONL 存储在未安装生产者时仍保留未知类型及其元数据（packages/session/session-persistence-jsonl/tests/native-source-admission.spec.ts，'preserves external attribution and own JSON metadata without a producer installed'）。检查该类型的核心消费者只与 'user' 或 'runtime-context' 比较（session-title、session-turn-outline、agent-loop），对未知类型直接放行，因此消息被保留，其文本内容原样到达模型；没有读取方会拒绝、截断或重新解释它。只有 WorkstreamService 读取该类型，用于对照接收方 Session 核对自己的投递回执（packages/experimental/workstream/src/index.ts 的 reconcileMessage）；它不对其他读取方增加校验、重放或授权要求。当前读取方：此变更之前写入的日志从不含该类型，因此对账找不到匹配项，行为不变。Workstream 状态：workstream/state 是新的普通事件类型，data.version 为 1 并携带完整快照，由 WorkstreamService 追加（index.ts 的 commit），并由 workstreamProjectionDefinition 严格解码，要求修订号连续且创建操作 id 不变。从未创建 Workstream 的 Session 不含此事件。不认识该类型的 harness 会在采纳任何事件之前拒绝该日志，因为它不在 KNOWN_SESSION_EVENT_TYPES 中且未标记 ignorable（packages/session/session-persistence/src/storage-contract.ts 的 validateStoredEvents 抛出 SessionFormatUnsupportedError，而非损坏恢复或尾部截断）。Session 格式版本保持不变。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/ticket/tests packages/experimental/workstream/tests packages/session/session-persistence/tests/storage-contract.spec.ts packages/session/session-persistence-jsonl/tests/native-source-admission.spec.ts packages/session/session-format-v3-to-v4/tests/message-sources.spec.ts：8 个文件、95 个测试通过，覆盖 Ticket 版本 1 历史、依据新来源类型对账的持久化 Workstream 投递、未知事件类型拒绝，以及未知来源类型的保留与准入。

<a id="dev-note"></a>
## 开发备注

无。
