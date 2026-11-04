---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-03-ticket-state

[English](2026-11-03-ticket-state.md) | 中文

## 概述

为实验性 Ticket 协调服务新增持久化的 ticket/state 事件根类型。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-03-ticket-state
baseline: false
changes:
  - root: "event:ticket/state"
    previous: null
    after: "56644029af422bde16ac0be0d8bbb2ef6f8fc73309ed740395c305accb155a93"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

这是没有既有记录需要解码的新事件根。Ticket 投影通过 schema 拒绝格式错误的快照，后续版本继续使用每个 Ticket 连续版本号的完整值快照。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/ticket/tests/ticket.spec.ts

<a id="dev-note"></a>
## 开发备注

无。
