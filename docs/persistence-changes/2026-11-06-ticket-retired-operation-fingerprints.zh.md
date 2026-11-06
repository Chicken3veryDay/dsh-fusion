---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-06-ticket-retired-operation-fingerprints

[English](2026-11-06-ticket-retired-operation-fingerprints.md) | 中文

## 概述

为 Ticket 操作记录新增可选字段 `retiredRequests`：结算墓碑记录按索引为每个已退役操作 id 保留一个请求指纹。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-06-ticket-retired-operation-fingerprints
baseline: false
changes:
  - root: "event:ticket/state"
    previous: "2026-11-06-ticket-settled-operation-compaction"
    after: "25fef18d9abece359bfd18f188ac1b218cfa5c9520a916eca2a6ef795776311f"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

不含该字段的记录仍然有效；本版本的读取方接受两种形式，并像以前一样确认对旧墓碑记录中操作的同一尝试重试。写入方仅在每个已退役 id 都有指纹时写出该字段，重放会拒绝长度与 `retiredIds` 不一致的列表。旧读取方的严格 Ticket 模式会拒绝带有该字段的事件，为该根报告 Ticket 恢复失败并继续预留其已知范围，因此会安全拒绝而不会误读状态。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/ticket/tests：review-r5-idempotency.spec.ts 中的 R5-m1（重放后参数不同的重试返回 TICKET_OPERATION_CONFLICT）和 review-r5-regressions.spec.ts 中的 R5-m1（指纹数量等于已退役 id 数量）通过。

<a id="dev-note"></a>
## 开发备注

无。
