---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-06-context-tree-sources

[English](2026-11-06-context-tree-sources.md) | 中文

## 概述

新增实验性上下文树使用的、由生产方拥有的 context-grant、context-activation 与 context-tree-catalog 消息来源。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-06-context-tree-sources
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-04-ticket-v2-workstream"
    after: "a0cfbdcb8f8cdf3d80caa667cd66be76343cd4f0a2c916e1e2f667907883ed33"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-04-ticket-v2-workstream"
    after: "e86bd65fe9cc12b99cab4ee6a706ec1daf0f892e896caf7c388c505c527b4206"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-04-ticket-v2-workstream"
    after: "0d0ba6281597452b206f8cb5ee78dcfca7a1b848f0850039617e719023520bf5"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-04-ticket-v2-workstream"
    after: "62e46ac5541aefa663e611bc7a30967ba1c3cafb8949371f33e8cf6e87dffafc"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效，现有判别值与 Session 头部版本均不变。每个新来源都附在普通用户消息上，其内容块是纯文本，因此忽略来源元数据的读取方仍能保持消息含义；只有生产方插件解释来源字段。仅在挂载可选启用的上下文树时，写入方才会加入这些类型。上下文树通过 Session 投影从这些消息重建状态，并忽略其无法读取字段的来源。本记录未运行旧版读取方。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/context-tree/tests packages/experimental/context-profile/tests：重放确定性、无法读取来源的容错，以及持久化并重放全部三种来源类型的真实 dsh 进程运行均通过。

<a id="dev-note"></a>
## 开发备注

无。
