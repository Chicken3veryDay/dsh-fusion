---
kind: upgrade-guide
description: "ACP profile 现在严格加载工作区指令，在每条客户端输入之后记录生成的 acp-context 消息，并为已准入的 ACP 输入添加标注。"
---
# ACP profile 增加接收方上下文与严格工作区指令

[English](guide.md) | 中文

## 变更

`dsh --profile acp` 把其 `agent-instructions` 配置项替换为 `mode: strict`。已发现的适用指令文件无法读取、文件超过 `maxSourceBytes`，或某条链的完整渲染超过 `maxBytes` 时，请求现在会在模型派发之前以 `AgentInstructionsError` 失败。此前该 profile 会省略或截断这些文本并继续。其他 profile 保持 `mode: legacy`。

每条 ACP 准入的客户端输入都会以 `source: { kind: 'user', input: { kind: 'acp' } }` 及其确切内容记录，其后每个 Session 会收到一条 `source.kind: 'acp-context'` 的生成 `user/message`。该消息声明接收方 `ACP automation` 并指明最近准入的输入。它是 `snapshot` 形式的事实，不带权限。目标状态改为作为运行时上下文快照的 `acp:goal` 段出现（长度超过 64 个字符的阻塞原因代码会被显式省略说明取代）。此前写入的 Session 日志仍然有效，且没有标注。

`@deepseek-ai/dsh-acp` 现在要求其 `inject` 列表包含 `sessionProjections` 与 `systemPrompt`，依赖 `zod`，并可选地读取 `goals` 服务。其 `apply` 为异步：冲突的 `acpContext` 投影注册会使插件激活失败。`PromptContext` 增加可选的 `revision`，`SystemPrompt` 增加 `contextRevisions()`，并新增 `GOAL_STATE` 上下文顺序。`UserMessage.source` 增加可选的 `input` 字段，`MessageSourceMap` 增加 `acp-context`。同版本 Session 读取方继续可用：[持久化记录](../../../persistence-changes/2026-11-08-acp-input-context.zh.md)列出了两个读取方向。

## 迁移

1. 在 ACP 组合包之上修补 `agent-instructions` 的 profile，必须重复 `mode: strict` 以保持严格加载，或设置 `mode: legacy` 以恢复截断：

   ```yaml
   - id: agent-instructions
     config:
       maxBytes: 65536
       mode: strict
   ```

2. 请求因 `AGENT_INSTRUCTIONS_BUDGET_EXCEEDED` 或 `AGENT_INSTRUCTIONS_SOURCE_TOO_LARGE` 失败时，提高 `maxBytes` 或 `maxSourceBytes`，或缩短所指名的指令文件。`AGENT_INSTRUCTIONS_SOURCE_UNREADABLE` 则修正权限。
3. 在随附 profile 之外挂载 `@deepseek-ai/dsh-acp` 的组合必须提供 `sessionProjections` 与 `systemPrompt`，并等待插件 fiber 以观察激活失败。
4. 按 `source.kind` 分支的 Session 读取方应把 `acp-context` 视为无特权的事实，并忽略未知的 `input` 通道。
5. 向 ACP 会话发送提示后，在其日志中确认客户端输入之后有一条 `acp-context` 消息。
