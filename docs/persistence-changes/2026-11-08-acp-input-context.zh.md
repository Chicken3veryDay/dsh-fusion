---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-08-acp-input-context

[English](2026-11-08-acp-input-context.md) | 中文

## 概述

为直接用户消息来源增加可选的 ACP 输入标注，并增加生成的、仅用于归属的 acp-context 来源类型。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-08-acp-input-context
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-06-context-grant-supersedes"
    after: "2278b039eb79c79ee88dcac9e47ffce004d9aa4053d3ace132cf9f05426e85e7"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-06-context-grant-supersedes"
    after: "63d4d8aaeb10e857369c5216809834980e2e62e9992571422fb8a61c6387736d"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-06-context-grant-supersedes"
    after: "1496b20df0126e0a752c3e95d77c5851b23ce6a32d78cfcb526a261b88ccd41b"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-06-context-grant-supersedes"
    after: "10004363f33e1c9c1187dfd8c74b1a149d969efffda88891c610debb8f16015b"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效：没有 input 的 user 来源表示未记录通道，读取方不会据此推断 ACP 来源、任务或角色。旧读取方处理新记录时，把 input 视为不变的 user 类型上未读取的可选属性，因此权限仍由 source.kind 与确切内容决定；它们把 acp-context 当作带 JSON 元数据的未知归属类型予以保留，因为该类型带有 persistenceAttribution 限定，不施加校验、回放或权限要求。Auto-review 将其归为事实，并使带标记的输入保持为用户指令。只有 ACP 插件会检查自己的 acp-context 类型，用于抑制重复数据包；恢复旧历史后，在带标记的输入出现之前，它把最近输入报告为未知。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/session/session-persistence-jsonl/tests/native-source-admission.spec.ts：48 个测试通过，包括对带标记、未知通道、acp-context 与无标记来源的精确保留。pnpm exec vitest run packages/sdk/client/tests/acp-source-projection.spec.ts：3 个测试通过，包括通过进程读取方读取随附 ACP profile 写出的会话日志；uv run pytest python/sdk/tests/test_acp_source_projection.py：2 个测试通过，包括同一份产品日志。pnpm exec vitest run packages/acp/acp/tests/context.spec.ts：11 个测试通过，包括在新写入方下恢复旧的无标记历史；context-recovery.spec.ts 增加了冷进程重启，以及有效、缺失与不兼容投影检查点的恢复。pnpm exec vitest run packages/experimental/auto-review/tests/auto-review.spec.ts：43 个测试通过；mounted-instructions.spec.ts 增加了 3 个使用已挂载严格插件的测试。

<a id="dev-note"></a>
## 开发备注

无。
