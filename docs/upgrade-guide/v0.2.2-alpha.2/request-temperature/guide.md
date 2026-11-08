---
kind: upgrade-guide
description: "The official DeepSeek route refuses a supplied temperature while reasoning is enabled."
---

# Official DeepSeek refuses temperature with reasoning

English | [中文](guide.zh.md)

## Change

DeepSeek documents that the official service fixes temperature at 1.0 in thinking mode. `@deepseek-ai/dsh-llm-deepseek` previously reported every supplied control as supported and sent the ignored value. A call whose captured connection targets the official origin and whose effort, or connection default, is not `off` now fails before credential, header, or HTTP work with `UNSUPPORTED_CONTROL` and `unsupportedControl: { control: 'temperature', reason: 'reasoning-active' }`. With `off` or `thinking: disabled` the value is still sent. Other origins report `temperature` as `unverified` with `protocol-unverified` and still send it. The wire request is unchanged.

A call without a `ConfigureCall` callback is refused from the adapter's synchronous connection facts before the route captures a connection, so a cold or populated model listing sees no credential read, header, or request. A call with a `ConfigureCall` callback is judged after the callback runs exactly once on the followed listing and may add, drop, or alter `temperature` or reasoning; the discovery credential and listing request may precede the refusal, and no inference credential, header, or request does. Because the early verdict comes first, an ineffective temperature on the official origin is reported ahead of a listed model that the listing would refuse. Calls without that temperature, or with reasoning `off`, keep the listing's `MODEL_UNSUPPORTED` and `CLIENT_UPGRADE_REQUIRED` verdicts, and an effort the model does not offer still fails with `UNSUPPORTED_REASONING_EFFORT`.

## Migration

1. Remove `temperature` from callers, extensions, or `agent/request` listeners that target the official route with reasoning enabled, or select `reasoningEffort: off` for those calls.
2. Run the call and confirm it completes, or that the refusal names `temperature` and `reasoning-active`. Gateways at other origins need no change.
