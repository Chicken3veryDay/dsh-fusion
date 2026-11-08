---
kind: upgrade-guide
description: "模型调用在准备阶段以 UNSUPPORTED_CONTROL 拒绝被声明为不支持的请求控制项，覆盖 prepareCall 的自定义适配器必须返回 assessControls。"
---

# 不受支持的请求控制项在准备阶段失败

[English](guide.md) | 中文

## 变更

`LlmRuntime.prepareCall()` 与 `ctx.llm.stream()` 现在会让捕获的适配器代次评估每个已提供的控制项（`reasoningEffort`、`temperature`、`maxTokens`、`stop`，包括模型默认值）。被声明为不支持的控制项以 `LlmError` 的 `UNSUPPORTED_CONTROL` 失败，`failure.unsupportedControl` 含 `control` 与封闭的 `reason`。直接流以携带同一失败的终端 `error` 结束。此前不会发生任何凭据解析、HTTP 请求或分派。

行为变化：

- `@deepseek-ai/dsh-llm-pi-ai` 以 `UNSUPPORTED_CONTROL` 拒绝 `stop`；此前在流开始时为 `UNSUPPORTED_OPTION`。
- Anthropic Messages 路由在推理处于启用状态或捕获的 `compat` 禁止时拒绝 `temperature`。早期版本会静默省略它。推理为 `off` 时仍会发送。`maxTokens` 仍是回答额度。
- `PreparedAdapterCall` 要求 `assessControls(controls)`，`PreparedLlmCall` 暴露 `assessment`。`LlmFailure` 新增可选的 `unsupportedControl`。

在 pi-ai 路由上传入 `stop`、在启用推理的 Anthropic 路由上传入 `temperature` 的 `ctx.llm.prepareCall()` 与 `ctx.llm.stream()` 调用方，以及覆盖 `prepareCall()` 的适配器作者会受影响。

## 迁移

1. 在覆盖 `prepareCall()` 的自定义 `LlmAdapter` 中，为返回对象添加 `assessControls`。使用 `@deepseek-ai/dsh-llm` 的 `assessSuppliedControls(controls, decide)`，或用 `undeclaredControlAssessment` 把每个控制项报告为 `unverified`。基类已返回后者。
2. 在调用方，对 pi-ai 路由去掉 `stop`。对启用推理的 Anthropic 路由去掉 `temperature`，或把 `reasoningEffort` 设为 `off`。处理 `UNSUPPORTED_CONTROL` 时读取 `failure.unsupportedControl`，不要依据 `message`。
3. 把匹配 pi-ai `stop` 的 `UNSUPPORTED_OPTION` 的代码替换为 `UNSUPPORTED_CONTROL`。
4. 运行 `pnpm run typecheck`，再对每个受影响路由运行一轮模型对话。确认被拒绝的调用在任何请求之前失败，修正后的调用可完成。
