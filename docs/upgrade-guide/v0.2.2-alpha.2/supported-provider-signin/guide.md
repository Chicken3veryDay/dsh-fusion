---
kind: upgrade-guide
description: "Anthropic Messages routes refuse subscription credentials from every source, and ChatGPT plan model offers follow the signed-in account and its resolvable models."
---

# Supported provider sign-in

English | [中文](guide.zh.md)

## Change

Direct Anthropic login offers API keys only. Saved Anthropic OAuth grants cannot authenticate DSH-owned requests, including explicit keyless profiles. Subscription tokens supplied as API keys are rejected before dispatch. Ambient `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_OAUTH_TOKEN` no longer authenticate these routes. The same refusal now applies to every route that speaks the Anthropic Messages protocol, including a catalog route overridden to `anthropic-messages` and a custom route, whether the token comes from an explicit, ambient or stored key, native provider auth, or an effective header; it fails with an `AUTH` error before any request is built. Ordinary API keys are unaffected. Existing records are preserved; the official Claude Code integration retains its own subscription login.

The `openai` ChatGPT plan route lists the signed-in account's visible models from the public model endpoint. The offers are limited to models the same configuration can resolve: an explicit `models` list narrows them, and a listed slug with no catalog or profile metadata is withheld (logged once) until a `models` entry supplies its capacities. Selecting a registered model no longer needs a live listing request, and each listing is bounded by the new `modelListTimeoutMs` profile field (default 15,000 ms). API-key routes retain the installed catalog, and `openai-codex` remains available as the legacy Codex integration.

When the Models page creates the first profile for a route that has only a stored sign-in and no key is typed, it now writes `signInOnly: true`, so the route keeps requiring that sign-in and never falls back to ambient API-key billing after sign-out. A profile without the field behaves as before.

## Migration

1. For direct Anthropic requests, select its API-key login or set `providers.anthropic.apiKeyEnv: ANTHROPIC_API_KEY` in your `llm-pi-ai` configuration and supply a supported API key. An explicit key reference takes precedence over an old saved grant.
2. For Claude subscription access, use the [official Claude Code integration](../../../../packages/subagent/subagent-claude-code/README.md) and complete its login. Do not copy its tokens into DSH credentials.
3. For ChatGPT plan access, choose `openai` and Sign in with ChatGPT. Confirm the model picker reflects that account. If a listed slug is newer than the installed catalog, add its capabilities through a `models` entry as described in the [adapter README](../../../../packages/llm/llm-pi-ai/README.md).
4. If a Models-page edit of a signed-in route should bill an API key instead, type the key in the card or set `apiKeyEnv`; remove `signInOnly` from a profile you want to authenticate from the environment.
5. Confirm a direct Anthropic request uses your API key or that ChatGPT inference completes. An authentication error requires repair of the selected credential; no request that resolves a plan grant silently selects API-key billing instead.
