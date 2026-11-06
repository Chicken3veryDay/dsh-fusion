---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-06-ticket-settled-operation-compaction

[English](2026-11-06-ticket-settled-operation-compaction.md) | 中文

## 概述

为 Ticket 操作记录增加可选的尝试归属和已退役操作 id，使结算能压缩请求指纹，同时保留操作 id 的拒绝规则。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-06-ticket-settled-operation-compaction
baseline: false
changes:
  - root: "event:ticket/state"
    previous: "2026-11-04-ticket-v2-workstream"
    after: "472f18aaf968aa9f8452ed5a3778eea72b860f0f16765ff015054b1423d8f9c6"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新读取方接受没有这些字段的历史记录，并保留其无标签操作。带标签操作只能退役到同一已结算尝试的记录中；重放拒绝不保留 id 的删除。旧 Ticket 读取方使用严格操作 schema，在应用快照前拒绝带有新增字段的记录，不会丢弃操作历史或执行副作用。SESSION_FORMAT_VERSION 不变；已提交的代际和已定稿确认记录保持不变。

<a id="verification"></a>
## 验证

第三轮回归套件通过，包括压缩后的完整 Session 重放，以及拒绝省略已退役操作 id 的压缩。同一回归套件针对固定基线提取的源码时，所有发现案例均失败。execution-lifecycle.spec.ts 仍覆盖历史规范化指纹。

<a id="dev-note"></a>
## 开发备注

无。
