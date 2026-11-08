---
kind: upgrade-guide
description: "Model calls refuse declared unsupported request controls with UNSUPPORTED_CONTROL at preparation, and custom prepareCall adapters must return assessControls."
---

# Unsupported request controls fail at preparation

English | [中文](guide.zh.md)

## Change

`LlmRuntime.prepareCall()` and `ctx.llm.stream()` now ask the captured adapter generation to assess every supplied control (`reasoningEffort`, `temperature`, `maxTokens`, `stop`, including model defaults). A declared unsupported control fails with `LlmError` code `UNSUPPORTED_CONTROL`, and `failure.unsupportedControl` holds the `control` and a closed `reason`. A direct stream ends with a terminal `error` finish carrying the same failure. No credential, HTTP request, or dispatch happens first.

Changed behavior:

- `@deepseek-ai/dsh-llm-pi-ai` refuses `stop` with `UNSUPPORTED_CONTROL`; it was `UNSUPPORTED_OPTION` at stream start.
- Anthropic Messages routes refuse `temperature` while reasoning is active or when the captured `compat` forbids it. Earlier versions omitted it silently. Reasoning `off` still sends it. `maxTokens` keeps its answer-allowance meaning.
- `PreparedAdapterCall` requires `assessControls(controls)`, and `PreparedLlmCall` exposes `assessment`. `LlmFailure` gains the optional `unsupportedControl`.

Callers of `ctx.llm.prepareCall()` and `ctx.llm.stream()` with `stop`, or with `temperature` on an active Anthropic reasoning route, and authors of adapters that override `prepareCall()` are affected.

## Migration

1. In a custom `LlmAdapter` that overrides `prepareCall()`, add `assessControls` to the returned object. Use `assessSuppliedControls(controls, decide)` from `@deepseek-ai/dsh-llm`, or `undeclaredControlAssessment` to report every control `unverified`. The base class already returns the latter.
2. In callers, drop `stop` on pi-ai routes. Drop `temperature`, or set `reasoningEffort` to `off`, on an Anthropic route with active reasoning. Handle `UNSUPPORTED_CONTROL` by reading `failure.unsupportedControl`, not `message`.
3. Replace code that matches `UNSUPPORTED_OPTION` for pi-ai `stop` with `UNSUPPORTED_CONTROL`.
4. Run `pnpm run typecheck`, then one model turn per affected route. Confirm the refused call fails before any request and the corrected call completes.
