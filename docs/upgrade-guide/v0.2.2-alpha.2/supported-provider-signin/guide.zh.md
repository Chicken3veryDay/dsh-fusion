---
kind: upgrade-guide
description: "Anthropic Messages 路由拒绝来自任何来源的订阅凭据，ChatGPT 套餐模型选项随已登录账户及其可解析的模型变化。"
---

# 受支持的提供方登录

[English](guide.md) | 中文

## 变更

Anthropic 直接登录仅提供 API 密钥。已存储的 Anthropic OAuth 授权无法认证 DSH 自行发送的请求，包括显式的无密钥 profile。作为 API 密钥提供的订阅令牌会在分派前被拒绝。环境中的 `ANTHROPIC_AUTH_TOKEN` 和 `ANTHROPIC_OAUTH_TOKEN` 不再认证这些路由。同一拒绝现在适用于每条使用 Anthropic Messages 协议的路由，包括被覆盖为 `anthropic-messages` 的目录路由和自定义路由，无论令牌来自显式、环境或已存密钥、提供方原生认证，还是有效标头；它会在构造任何请求之前以 `AUTH` 错误失败。普通 API 密钥不受影响。已有记录保留；官方 Claude Code 集成保留自己的订阅登录。

`openai` ChatGPT 套餐路由从公共模型端点列出已登录账户的可见模型。供给限定为同一配置能够解析的模型：显式 `models` 列表会收窄供给，没有目录或 profile 元数据的已列出 slug 不会进入供给（记录一次日志），直到 `models` 条目补全其容量。无论在模型选择器中还是通过 ACP `session/set_config_option`，选择已注册模型都不再需要实时列表请求；每次模型查询（包括其凭据读取）都受新的 `modelListTimeoutMs` profile 字段限制（默认 15,000 毫秒）。ACP 模型变更现在返回最近一次列出目录的选项状态，而不再次列表。API 密钥路由保留已安装目录，`openai-codex` 继续作为旧版 Codex 集成可用。

当模型页面为仅有已存登录的路由创建首个 profile 且未键入密钥时，现在会写入 `signInOnly: true`，因此该路由继续要求这一登录，退出登录后绝不回退到环境中的 API 密钥计费。没有该字段的 profile 行为不变。

## 迁移

1. 对于 Anthropic 直接请求，选择其 API 密钥登录，或在 `llm-pi-ai` 配置中设置 `providers.anthropic.apiKeyEnv: ANTHROPIC_API_KEY` 并提供受支持的 API 密钥。显式密钥引用优先于已有存储授权。
2. 对于 Claude 订阅访问，使用 [官方 Claude Code 集成](../../../../packages/subagent/subagent-claude-code/README.zh.md) 并完成其登录。不要将其令牌复制到 DSH 凭据中。
3. 对于 ChatGPT 套餐访问，选择 `openai` 和 Sign in with ChatGPT。确认模型选择器反映该账户。如果列出的 slug 比已安装目录更新，按 [适配器 README](../../../../packages/llm/llm-pi-ai/README.zh.md) 所述通过 `models` 条目添加其能力。
4. 如果对已登录路由的模型页面编辑应改为按 API 密钥计费，请在卡片中键入密钥或设置 `apiKeyEnv`；想让某个 profile 从环境认证时，请移除其 `signInOnly`。
5. 确认 Anthropic 直接请求使用了你的 API 密钥，或 ChatGPT 推理完成。认证错误需要修复所选凭据；解析套餐授权的请求不会静默改用 API 密钥计费。
