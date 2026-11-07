---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-06-context-grant-supersedes

[English](2026-11-06-context-grant-supersedes.md) | 中文

## 概述

为 context-grant 消息来源新增可选的 supersedes 摘要。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-06-context-grant-supersedes
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-06-workstream-notice-source"
    after: "966cf861719ca1968084da9040b9041e40f31074a43e62204ffb350faf5d9182"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-06-workstream-notice-source"
    after: "f698aa864cdbe7f2cc2d7db08bbfe49c0ffd1df0d8843d365316e74c93d8460a"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-06-workstream-notice-source"
    after: "41e02cf17c8d3c7ead8e5d25a78bde996d098e14f301b1da844b7f0aca387ad0"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-06-workstream-notice-source"
    after: "1ca9cdbf4d168e4d0876499a7c6de2de9d2604bddea043e37ffe5d3b654a2ab3"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效：该字段可选，且所有较早的授权中都不存在。较旧的读取方会忽略它，因为上下文树投影解析授权来源时不做严格字段检查，而消息文本已经向模型给出同样的说明。较新的读取方把缺失该字段视为首次授权。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/context-tree packages/experimental/context-map packages/experimental/context-profile packages/experimental/context-index：28 个文件、284 个测试通过（sweep-fixes.spec.ts 断言重新授予的章节带有 supersedes）。

<a id="dev-note"></a>
## 开发备注

无。
