---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-06-context-map-state

[English](2026-11-06-context-map-state.md) | 中文

## 概述

新增实验性 context-map 包。它追加新的 Session 事件类型 `context-map/state`：每次项目地图编辑一条记录，携带操作、执行操作的智能体，以及带连续修订号的完整地图快照。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-06-context-map-state
baseline: false
changes:
  - root: "event:context-map/state"
    previous: null
    after: "ba50066aeeb804e1c799343f712eda4d03aeeace69a606cffcc967ac9f0c8784"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

Session 格式版本不变。不含 `context-map/state` 记录的日志读取方式与以前完全相同。包含该记录的日志会被早于该类型的构建拒绝，因为那个构建没有把它列为已知事件类型；这遵循现有的未知事件拒绝行为。

<a id="verification"></a>
## 验证

context-map 单元测试覆盖修订冲突、连续日志的重放和缺口的拒绝；真实 dsh 进程测试表明主 Session 记录了地图编辑，而不含策展者对话。

<a id="dev-note"></a>
## 开发备注

无。
