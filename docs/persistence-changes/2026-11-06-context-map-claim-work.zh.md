---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-06-context-map-claim-work

[English](2026-11-06-context-map-claim-work.md) | 中文

## 概述

为 `context-map/state` 的操作增加可选的 `work` 指纹，在 `claim` 时写入，使重启后仍能统计针对同一工作启动的策展者运行次数。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-06-context-map-claim-work
baseline: false
changes:
  - root: "event:context-map/state"
    previous: "2026-11-06-context-map-index-ack"
    after: "2c6d8e2433f44afffea786a0cc337c9d4af94de63680d567914cdea867d4646d"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效：该字段可选，所有更早的事件都没有它。使用严格模式的旧读取方会拒绝带有 `work` 的记录；此实验性包尚未在更早版本中发布。新读取方把缺失视为未记录尝试，投影状态版本升至 3，旧检查点会从日志重新折叠。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/context-map/tests：全部测试通过，包括认领计数回放和服务重启后的重试上限。

<a id="dev-note"></a>
## 开发备注

无。
