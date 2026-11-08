---
kind: upgrade-guide
description: "Codex routes use SSE instead of automatic WebSocket selection when transport is omitted."
---

# Codex routes default to SSE

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-llm-pi-ai` routes using `openai-codex-responses` select SSE when their profile omits `transport`. Earlier versions used pi-ai's automatic transport selection, which could open a WebSocket and fall back to SSE within one Harness attempt. Explicit transport settings keep their behavior.

## Migration

1. Keep `transport` unset to use SSE. If your deployment requires the previous automatic selection, set `transport: auto` in the route's existing `llm-pi-ai.providers.<provider>` profile in `cordis.patch.yml`.
2. Run a model turn after restarting the profile and confirm the selected model completes its tool calls. A deployment retaining `transport: auto` also retains pi-ai's automatic transport fallback behavior.
