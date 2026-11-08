---
kind: upgrade-guide
description: "OpenAI Responses refuses selected controls that its bound account omits."
---

# OpenAI account controls

English | [中文](guide.zh.md)

## Change

OpenAI Responses calls to `https://api.openai.com/v1` with a session-shaped effective credential refuse supplied `temperature` and `maxTokens` with `UNSUPPORTED_CONTROL` and `account-omits`. Previously pi-ai silently omitted these fields. Configured model defaults count as supplied controls. Refusal occurs during preparation, before a request header or assistant output is recorded; the loop retains diagnostic user input. Transient authentication failures discovered during preparation retain normal request-stream retry handling. Each new attempt resolves authentication afresh; a failed prepared operation never resolves it twice. Authentication policy refusals and cancellation remain immediate.

## Migration

1. Remove `temperature` and `maxTokens` from the call or the route's model defaults when using the affected account.
2. If these controls are required, explicitly configure a compatible API-key route. The harness never switches billing or changes stored accounts automatically.
3. Confirm preparation succeeds and inspect the request on that route. Legacy `maxTokens` remains an allowance with pi-ai's minimum and context-clamp behavior; it is not a new hard-total limit.

A prepared in-flight call retains its captured credential after sign-out. A new stored-only call after sign-out refuses rather than falling back to ambient credentials. Persistence classification is recorded in the [acknowledgement](../../../persistence-changes/2026-11-08-openai-account-omits.md).
