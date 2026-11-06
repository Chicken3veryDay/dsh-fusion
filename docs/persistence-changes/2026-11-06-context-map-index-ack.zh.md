---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-06-context-map-index-ack

[English](2026-11-06-context-map-index-ack.md) | 中文

## 概述

通过显式 index-ack 操作记录上下文地图策展成功完成。领取保留上次完成的索引摘要；中断的运行使索引仍可再次尝试。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-06-context-map-index-ack
baseline: false
changes:
  - root: "event:context-map/state"
    previous: "2026-11-06-context-map-state"
    after: "6b52d5e9ddcd9dead0af596aac53170fba801bc1d174473837d8436f6f2cfc0d"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

快照字段和事件版本不变。当前读取方接受已有操作类型，并将没有 index-ack 的旧领取时摘要视为未完成。旧读取方在严格操作验证期间拒绝未知的 index-ack 操作，不会把它解释成已完成编辑。不支持降级包含新操作的 Session；SESSION_FORMAT_VERSION 保持不变。

<a id="verification"></a>
## 验证

上下文地图策展恢复回归测试覆盖部分运行因步骤限制、模型失败以及策展者处置和重启而中断，随后成功重试。组合包快照记录首次运行尚未完成时 indexChanged 为 true。投影恢复只在显式确认后公开已完成摘要。

<a id="dev-note"></a>
## 开发备注

无。
