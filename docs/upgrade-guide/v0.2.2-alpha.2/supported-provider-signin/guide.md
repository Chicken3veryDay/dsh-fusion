---
kind: upgrade-guide
description: "Direct Anthropic subscription credentials are refused and ChatGPT plan model offers follow the signed-in account."
---

# Supported provider sign-in

English | [中文](guide.zh.md)

## Change

Direct Anthropic login offers API keys only. Saved Anthropic OAuth grants cannot authenticate DSH-owned requests, including explicit keyless profiles. Subscription tokens supplied as API keys are rejected before dispatch. Ambient `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_OAUTH_TOKEN` no longer authenticate these routes. Existing records are preserved; the official Claude Code integration retains its own subscription login.

The `openai` ChatGPT plan route lists the signed-in account's visible models from the public model endpoint. API-key routes retain the installed catalog, and `openai-codex` remains available as the legacy Codex integration.

## Migration

1. For direct Anthropic requests, select its API-key login or set `providers.anthropic.apiKeyEnv: ANTHROPIC_API_KEY` in your `llm-pi-ai` configuration and supply a supported API key. An explicit key reference takes precedence over an old saved grant.
2. For Claude subscription access, use the [official Claude Code integration](../../../../packages/subagent/subagent-claude-code/README.md) and complete its login. Do not copy its tokens into DSH credentials.
3. For ChatGPT plan access, choose `openai` and Sign in with ChatGPT. Confirm the model picker reflects that account. If a listed slug is newer than the installed catalog, add its capabilities through a `models` entry as described in the [adapter README](../../../../packages/llm/llm-pi-ai/README.md).
4. Confirm a direct Anthropic request uses your API key or that ChatGPT inference completes. An authentication error requires repair of the selected credential; no request that resolves a plan grant silently selects API-key billing instead.
