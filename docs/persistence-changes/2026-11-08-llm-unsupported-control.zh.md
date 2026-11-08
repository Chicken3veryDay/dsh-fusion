---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-08-llm-unsupported-control

[English](2026-11-08-llm-unsupported-control.md) | 中文

## 概述

为持久化的 LlmFailure 新增可选的 unsupportedControl 字段，给出被拒绝的请求控制项与封闭的原因。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-08-llm-unsupported-control
baseline: false
changes:
  - root: "event:assistant/attempt"
    previous: "2026-09-16-session-format-v4"
    after: "59d5e0bb1dd9a1fcfda395be3d7fcc4a29601693e321c754785d79a9f8e4b059"
    decision: same-version
  - root: "event:assistant/message"
    previous: "2026-09-16-session-format-v4"
    after: "a4602b43c6d5c0869982a422103425bb6b7889e2da3477ffed2ce82421684ee0"
    decision: same-version
  - root: "event:llm/retry"
    previous: "2026-09-14-image-offload"
    after: "c30f7baa88c5a378571cb8516c7fb8fde457886aacacd19c6a3bb446c1d1af77"
    decision: same-version
  - root: "event:turn/end"
    previous: "2026-09-16-session-format-v4"
    after: "4b511bc7493a9cf5aa5d861f246266bd0482ce66c383e1711e5d1fd67227a0a3"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效，因为该字段可选。读取早期记录的读者看不到此字段。旧读者读取新记录时会忽略未知的可选属性。只有 UNSUPPORTED_CONTROL 失败会写入它，没有消费方把缺失视为支持。Session 格式版本与代次不变。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/llm/llm packages/llm/llm-pi-ai packages/llm/llm-deepseek packages/core/agent-loop：adapter-failure、service、controls 与 request-reconstruction 规格通过，包括格式错误的载体回退为 UNKNOWN。

<a id="dev-note"></a>
## 开发备注

无。
