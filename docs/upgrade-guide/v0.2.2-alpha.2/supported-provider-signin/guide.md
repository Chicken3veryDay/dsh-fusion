---
kind: upgrade-guide
description: "Anthropic login uses stored subscription OAuth, and ChatGPT plan model offers follow the signed-in account and its resolvable models."
---

# Supported provider sign-in

English | [中文](guide.zh.md)

## Change

Anthropic login offers subscription OAuth through the maintained pi-ai Messages transport. DSH owns the agent loop, tools, prompt assembly and persistence; it starts no Claude Code backend. Automatic signed-in routes and profiles with `signInOnly: true` require stored OAuth and refuse API-key replacements or ambient API-key fallback. The transport supplies its required compatibility headers and identity prefix; agent-loop requests record the prefix in `system/message`. Subscription tokens supplied as API keys or auth-header overrides remain rejected. Explicitly configured API-key routes are separate and remain available. Ambient `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_OAUTH_TOKEN` do not import a subscription login.

The `openai` ChatGPT plan route lists the signed-in account's visible models from the public model endpoint. The offers are limited to models the same configuration can resolve: an explicit `models` list narrows them, and a listed slug with no catalog or profile metadata is withheld (logged once) until a `models` entry supplies its capacities. Selecting a registered model no longer needs a live listing request, in the Models picker or through ACP `session/set_config_option`, and each model lookup, including its credential reads, is bounded by the new `modelListTimeoutMs` profile field (default 15,000 ms). An ACP model change now returns the option state of the latest listed catalog rather than listing again. API-key routes retain the installed catalog, and `openai-codex` remains available as the legacy Codex integration.

When the Models page creates the first profile for a route that has only a stored sign-in and no key is typed, it now writes `signInOnly: true`, so the route keeps requiring that sign-in and never falls back to ambient API-key billing after sign-out. A profile without the field behaves as before.

## Migration

1. For Claude subscription access, choose Anthropic OAuth sign-in in DSH. Keep `providers.anthropic.signInOnly: true` on saved profiles and omit `apiKeyEnv`. Existing DSH-owned OAuth grants remain usable.
2. Do not copy tokens from Claude Code. Its existing delegated-agent integration remains a separate capability and is not required for DSH-owned inference. Configure `apiKeyEnv` only when deliberately choosing a separate API-key route.
3. For ChatGPT plan access, choose `openai` and Sign in with ChatGPT. Confirm the model picker reflects that account. If a listed slug is newer than the installed catalog, add its capabilities through a `models` entry as described in the [adapter README](../../../../packages/llm/llm-pi-ai/README.md).
4. If a Models-page edit of a signed-in route should bill an API key instead, type the key in the card or set `apiKeyEnv`; remove `signInOnly` from a profile you want to authenticate from the environment.
5. Confirm Claude or ChatGPT inference completes through the selected account. After sign-out, a subscription-only route must fail with `AUTH`; repair its sign-in rather than supplying an API key.
