---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-06-context-core-budget

[English](2026-11-06-context-core-budget.md) | 中文

## 概述

在 context-grant 来源的可选字段 coreBytes 中记录急切上下文授权的字节费用。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-06-context-core-budget
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-06-context-tree-sources"
    after: "2f8ee255ee2c2978dce5667721de59f0d87a7af418c736271361465f64140f5d"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-06-context-tree-sources"
    after: "d224a9637a3bdc88943d15a9c8f3dbe551a4d320b2965c2521a1f6a113d4d24f"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-06-context-tree-sources"
    after: "d69f11beabb938e9249b8095fd9f1a989f418560e9b7b71a7194fe196c0b8a68"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-06-context-tree-sources"
    after: "75159c38cc4fc8177f26157c0d8ba68cf7854d618c4296e1eabdf4493b2e8bb0"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

没有 coreBytes 的已有消息仍可读取。较早的写入方未区分急切授权和显式加载，因此新的急切授权会等待这些消息被撤销。新的显式加载记录零，急切授权记录其字节数。旧读取方忽略可选字段，继续加载和撤销授权。新读取方从已记录、已排队和已认领的消息重建费用。私有 contextTree 投影的状态版本变更，不兼容检查点会从 Session 日志重新折叠。Session 格式版本不变。

<a id="verification"></a>
## 验证

context-tree 回归用例覆盖已排队、已认领及已记录时的核心选择替换、压缩释放预算、旧授权、序列化检查点与后缀回放，以及重新分组后的章节和工具重新加载。

<a id="dev-note"></a>
## 开发备注

无。
