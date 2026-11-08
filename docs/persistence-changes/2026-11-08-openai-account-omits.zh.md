---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-08-openai-account-omits

[English](2026-11-08-openai-account-omits.md) | 中文

## 概述

为持久化 unsupportedControl 原因联合添加 account-omits，用于 OpenAI Responses 请求入日志前的拒绝。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-08-openai-account-omits
baseline: false
changes:
  - root: "event:assistant/attempt"
    previous: "2026-11-08-llm-unsupported-control"
    after: "26e5aaf509bd226d8197e7d3824a4d5edb0c1555b508b62f418835f037c43963"
    decision: same-version
  - root: "event:assistant/message"
    previous: "2026-11-08-llm-unsupported-control"
    after: "67b40f5b2a6001da68f91a0a12f69b37e8583a20bd2697d5f0ca20f2431c189e"
    decision: same-version
  - root: "event:llm/retry"
    previous: "2026-11-08-llm-unsupported-control"
    after: "89c3dddc900b35125504876c4e130ee078f46d8463b49eced6027a2d8fbee7a7"
    decision: same-version
  - root: "event:turn/end"
    previous: "2026-11-08-llm-unsupported-control"
    after: "aefdcfa65f9adf578ac2708c241ecbbc2f4f0fa1cd31d2a48a7f73f3f43bd83b"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

结构分类器在 assistant/attempt、assistant/message、llm/retry 与 turn/end 上报告 union-variants-changed，要求兼容性审查。已有原因与记录保持有效。未改变的存储事件读取器接受已知错误事件并保留失败数据；没有消费方将未知原因解释为执行成功或受支持。已发布基线的失败归一化器将新原因映射为 UNKNOWN 并保留错误消息；当前读取器保留 account-omits。两个方向的错误结果仍为错误。写入版本和已提交代次不变。

<a id="verification"></a>
## 验证

源代码探针 .artifacts/account-reader-evidence.ts 对新的 account-control-refusal 记录执行了已发布基线 的归一化器和未改变的 validateStoredEvents：旧归一化为 UNKNOWN，当前为 UNSUPPORTED_CONTROL/account-omits，存储接受错误事件。pnpm run test:snapshot snapshots/sdk/sdk.snapshot.ts -t account-control-refusal：1 个测试通过。所属 adapter-failure 回归保留新原因并拒绝未知原因。

<a id="dev-note"></a>
## 开发备注

无。
