---
kind: upgrade-guide
description: "通过 Script SDK 发起的 Workflow 调用会在调用方 Agent 会话中写入持久运行记录。"
---

# Script SDK 调用的 Workflow 记录

[English](guide.md) | 中文

## 变更

Agent 拥有的 `run_code` 内 `tools.workflow(...)` 调用现在会生成与直接 Workflow 调用相同的四种 `tool-workflow/*` 会话事件。假定嵌套 Workflow 调用没有持久运行记录的消费方必须处理这些事件。只有 dispose 成功后才写入运行终态记录；清理失败时，后台任务可以报告已结算的执行结果，而 Workflow 记录保持未结束。现有事件载荷和已提交的会话代次保持不变。

## 迁移

1. 在自定义会话消费方中，按 `runId` 标识 Workflow 运行，不依赖 transport 调用嵌套。使用现有的运行开始、成员开始、成员结束和运行结束记录，不要从嵌套工具行派生重复运行。
2. 通过 `run_code` 中的 `tools.workflow(...)` 运行 Workflow，确认其独立 Workflow 卡片显示子会话，并在重新加载父会话后仍可查看。缺少这些记录的旧日志无法重建它们；历史数据不会被重写。
