---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-01-retained-participants

[English](2026-11-01-retained-participants.md) | 中文

## 概述

新增必读且仅记日志的保留运行时所有权、不可变 Fusion 成员及参与者建立记录。这些记录不授予激活权限。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-01-retained-participants
baseline: false
changes:
  - root: "event:agent/runtime-owner"
    previous: null
    after: "e294e49cea481ff4004f5b3ec405c8bcf535185314d7658f9377a00526ddbca2"
    decision: same-version
  - root: "event:fusion/participant-established"
    previous: null
    after: "33ec8821f825146667b0f5b98d8e28fc93dfbc5049cfada6c930b9634cfe053d"
    decision: same-version
  - root: "event:fusion/roster"
    previous: null
    after: "4bcabd32e675d9dce15ec5bba10ed87ae579a70376109c8071c7ab8987aee8ee"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已针对保留的上游树 d3c6ee1d1f0ec8b71c92e1b62d0cf9a8d6553bf8 执行两个读取方向的检查。其物理 JSONL 解析器／写入器及已存事件校验器与当前源码逐字节相同；测试载入保留源码及保留的已知事件集合。上游编码的标准记录通过当前解析器及标准 Agent 恢复；标准记录保持不变。上游已存事件校验器在受管理激活前分别拒绝每种新增必读记录及组合后的受管理根。物理 scanLog 本身不拒绝未知必读记录：拒绝由持久化提供方读取路径中的 validateStoredEvents 执行。当前真实 JSONL 恢复拒绝缺失、格式无效或重复的所有权／成员证据，以及格式无效或重复的建立证据。缺失建立记录表示可恢复的未完成准备；已建立的参与者在磁盘上缺失时拒绝替换。必读判别字段足以保证安全拒绝，因此写入器保持 V4。不更改锁定历史或已发布 schema。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/fusion-participants/tests/lifecycle.spec.ts：23 个测试通过，退出码 0（parsers-final-2.log）。包括保留的上游解析器／写入器与已存事件校验器、每种必读事件的独立检查、标准恢复及八种持久载荷损坏情况。SDK 记录会话与打包 Python sdk-retained 回放均通过，模型请求为零且排队输入未被领取。证据：dsh-p03-completion-r1/sdk-final-2.log 与 python-retained-final-2.log。Python 打包命令在生成所测试可执行文件后因无关的 tslib 锁定完整性不匹配而失败；此确认不认证打包或独立审阅。

<a id="dev-note"></a>
## 开发备注

无。
