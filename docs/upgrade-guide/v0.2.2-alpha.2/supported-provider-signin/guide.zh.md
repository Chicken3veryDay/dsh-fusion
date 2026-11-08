---
kind: upgrade-guide
description: "Anthropic 登录使用已存储的订阅 OAuth，ChatGPT 套餐模型选项随已登录账户及其可解析的模型变化。"
---

# 受支持的提供方登录

[English](guide.md) | 中文

## 变更

Anthropic 登录通过维护中的 pi-ai Messages 传输提供订阅 OAuth。DSH 负责代理循环、工具、提示词组装和持久化，不启动 Claude Code 后端。自动登录路由及设置了 `signInOnly: true` 的 profile 必须使用已存储的 OAuth，拒绝 API 密钥替代及环境 API 密钥回退。传输提供必需的兼容标头和身份前缀；该前缀记录在 `system/message` 中。通过 API 密钥或认证标头覆盖提供的订阅令牌仍会被拒绝。显式配置的 API 密钥路由独立存在，仍可使用。环境中的 `ANTHROPIC_AUTH_TOKEN` 和 `ANTHROPIC_OAUTH_TOKEN` 不会导入订阅登录。

`openai` ChatGPT 套餐路由从公共模型端点列出已登录账户的可见模型。供给限定为同一配置能够解析的模型：显式 `models` 列表会收窄供给，没有目录或 profile 元数据的已列出 slug 不会进入供给（记录一次日志），直到 `models` 条目补全其容量。无论在模型选择器中还是通过 ACP `session/set_config_option`，选择已注册模型都不再需要实时列表请求；每次模型查询（包括其凭据读取）都受新的 `modelListTimeoutMs` profile 字段限制（默认 15,000 毫秒）。ACP 模型变更现在返回最近一次列出目录的选项状态，而不再次列表。API 密钥路由保留已安装目录，`openai-codex` 继续作为旧版 Codex 集成可用。

当模型页面为仅有已存登录的路由创建首个 profile 且未键入密钥时，现在会写入 `signInOnly: true`，因此该路由继续要求这一登录，退出登录后绝不回退到环境中的 API 密钥计费。没有该字段的 profile 行为不变。

## 迁移

1. 对于 Claude 订阅访问，在 DSH 中选择 Anthropic OAuth 登录。保存的 profile 保持 `providers.anthropic.signInOnly: true`，并省略 `apiKeyEnv`。已有的 DSH OAuth 授权仍可使用。
2. 不要从 Claude Code 复制令牌。其现有委派代理集成仍是独立能力，DSH 自行推理不需要该集成。仅在有意选择独立的 API 密钥路由时配置 `apiKeyEnv`。
3. 对于 ChatGPT 套餐访问，选择 `openai` 和 Sign in with ChatGPT。确认模型选择器反映该账户。如果列出的 slug 比已安装目录更新，按 [适配器 README](../../../../packages/llm/llm-pi-ai/README.zh.md) 所述通过 `models` 条目添加其能力。
4. 如果对已登录路由的模型页面编辑应改为按 API 密钥计费，请在卡片中键入密钥或设置 `apiKeyEnv`；想让某个 profile 从环境认证时，请移除其 `signInOnly`。
5. 确认 Claude 或 ChatGPT 通过所选账户完成推理。退出登录后，仅订阅路由必须以 `AUTH` 失败；应修复登录，而不是提供 API 密钥。
