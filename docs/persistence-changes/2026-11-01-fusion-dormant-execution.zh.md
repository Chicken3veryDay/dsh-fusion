---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-01-fusion-dormant-execution

[English](2026-11-01-fusion-dormant-execution.md) | 中文

## 概述

新增必读且仅用于日志的 Fusion 执行实例、授权、撤销、效果开始、生产方结算与独立协调事实。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-01-fusion-dormant-execution
baseline: false
changes:
  - root: "event:fusion/effect-reconciled"
    previous: null
    after: "0b74adcfdeb1e21f5c63655b06370a71873a7c87c7c51b90f39d02e7b21531f1"
    decision: same-version
  - root: "event:fusion/effect-settled"
    previous: null
    after: "2ef5bf51ec3e9de6ff96b6fa97a39f0811663cd60b265a3da9a1fabd12935344"
    decision: same-version
  - root: "event:fusion/effect-started"
    previous: null
    after: "8dc5ab71c48f8234fdfba2162b2d45780e9abc12b73f2dea357a626cf4a515db"
    decision: same-version
  - root: "event:fusion/execution-granted"
    previous: null
    after: "c3285588abb3a912538797c61a7a0750f42c7850dd6e370d3d675eb582037be0"
    decision: same-version
  - root: "event:fusion/execution-opened"
    previous: null
    after: "42a44ca1bb21c3c9fc730e5a29d973596f83a735bfd67aa70e4af1f46fe4b81e"
    decision: same-version
  - root: "event:fusion/execution-revoked"
    previous: null
    after: "6873557fc1f0c7e02c51e17b5654374f92522a96a1af298fd8f7938ffa92ab2c"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

现有标准日志和早期停驻 Fusion 历史仍可读取。恢复将权限初始化为关闭状态，绝不重放效果。六个新事件判别符均为必读，旧读取器会拒绝受管理历史，不会推断权限或完成。现有事件与已发布物理格式不变。

<a id="verification"></a>
## 验证

定向执行与投影测试覆盖持久化开始、最后调度栅栏、排空和确定性检查点重放。独立进程夹具覆盖不确定性保留、退出后锁获取以及不伪造生产方结算的协调。保留的上游解析器拒绝每个新增必读判别符；SDK 重放验证生产环境关闭权限的发布，且请求与领取均为零。

<a id="dev-note"></a>
## 开发备注

无。
