---
kind: upgrade-guide
description: "Codex 路由省略 transport 时使用 SSE，不再自动选择 WebSocket。"
---

# Codex 路由默认使用 SSE

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-llm-pi-ai` 中使用 `openai-codex-responses` 的路由在 profile 省略 `transport` 时选择 SSE。此前版本使用 pi-ai 的自动传输选择，可能在一次 Harness 尝试中先打开 WebSocket，再回退到 SSE。显式传输设置保留其行为。

## 迁移

1. 保持 `transport` 未设置即可使用 SSE。如果部署需要此前的自动选择，请在 `cordis.patch.yml` 中该路由现有的 `llm-pi-ai.providers.<provider>` profile 内设置 `transport: auto`。
2. 重启 profile 后运行一个模型轮次，确认所选模型完成工具调用。保留 `transport: auto` 的部署也会保留 pi-ai 的自动传输回退行为。
