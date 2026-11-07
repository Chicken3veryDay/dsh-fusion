---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-06-workstream-notice-source

[English](2026-11-06-workstream-notice-source.md) | 中文

## 概述

新增仅用于归属的 workstream-notice 用户消息来源类型。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-06-workstream-notice-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-06-context-core-budget"
    after: "899471c1cea93e0482c1d431f82b7bf437123d56497de8a8422c921032611b33"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-06-context-core-budget"
    after: "38938bc75f551d98c27e05556e8613e48abaf06e366324d8e60c57030fd9b4d0"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-06-context-core-budget"
    after: "a10a18da0b44b8830b2726fc2f53485da7afe1d4907ec38be9ba6bb4dc3c08ee"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-06-context-core-budget"
    after: "e31d8f3851950677d571014bb101f60d4f443e5f1fffe333f8f30ba8d3f0139c"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

仅新增一个归属类型。Workstream 在两处写入它：投递给被恢复成员的协调者移交通知，以及注入到被恢复的 Workstream 所有者、列出上一轮未完成成员的通知。没有读取方据此回放、校验或授权；未安装 Workstream 包的读取方保留已记录的消息文本。现有日志不含此类型。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/workstream/tests packages/experimental/workstream-profile/tests/review-opus-autonomy-e2e-interrupted.spec.ts packages/experimental/workstream-profile/tests/review-opus-autonomy-e2e-handoff.spec.ts：13 个文件，65 个测试通过，2 个跳过。

<a id="dev-note"></a>
## 开发备注

无。
