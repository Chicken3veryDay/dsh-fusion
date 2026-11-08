---
kind: upgrade-guide
description: "Anthropic 直接请求拒绝订阅凭据，ChatGPT 套餐模型选项随已登录账户变化。"
---

# 受支持的提供方登录

[English](guide.md) | 中文

## 变更

Anthropic 直接登录仅提供 API 密钥。已存储的 Anthropic OAuth 授权无法认证 DSH 自行发送的请求，包括显式的无密钥 profile。作为 API 密钥提供的订阅令牌会在分派前被拒绝。环境中的 `ANTHROPIC_AUTH_TOKEN` 和 `ANTHROPIC_OAUTH_TOKEN` 不再认证这些路由。已有记录保留；官方 Claude Code 集成保留自己的订阅登录。

`openai` ChatGPT 套餐路由从公共模型端点列出已登录账户的可见模型。API 密钥路由保留已安装目录，`openai-codex` 继续作为旧版 Codex 集成可用。

## 迁移

1. 对于 Anthropic 直接请求，选择其 API 密钥登录，或在 `llm-pi-ai` 配置中设置 `providers.anthropic.apiKeyEnv: ANTHROPIC_API_KEY` 并提供受支持的 API 密钥。显式密钥引用优先于已有存储授权。
2. 对于 Claude 订阅访问，使用 [官方 Claude Code 集成](../../../../packages/subagent/subagent-claude-code/README.zh.md) 并完成其登录。不要将其令牌复制到 DSH 凭据中。
3. 对于 ChatGPT 套餐访问，选择 `openai` 和 Sign in with ChatGPT。确认模型选择器反映该账户。如果列出的 slug 比已安装目录更新，按 [适配器 README](../../../../packages/llm/llm-pi-ai/README.zh.md) 所述通过 `models` 条目添加其能力。
4. 确认 Anthropic 直接请求使用了你的 API 密钥，或 ChatGPT 推理完成。认证错误需要修复所选凭据；解析套餐授权的请求不会静默改用 API 密钥计费。
