---
kind: upgrade-guide
description: "The official DeepSeek route refuses a supplied temperature while reasoning is enabled."
---

# Official DeepSeek refuses temperature with reasoning

English | [中文](guide.zh.md)

## Change

DeepSeek documents that the official service fixes temperature at 1.0 in thinking mode. `@deepseek-ai/dsh-llm-deepseek` previously reported every supplied control as supported and sent the ignored value. A call whose captured connection targets the official origin and whose effort, or connection default, is not `off` now fails before credential, header, or HTTP work with `UNSUPPORTED_CONTROL` and `unsupportedControl: { control: 'temperature', reason: 'reasoning-active' }`. With `off` or `thinking: disabled` the value is still sent. Other origins report `temperature` as `unverified` with `protocol-unverified` and still send it. The wire request is unchanged.

## Migration

1. Remove `temperature` from callers, extensions, or `agent/request` listeners that target the official route with reasoning enabled, or select `reasoningEffort: off` for those calls.
2. Run the call and confirm it completes, or that the refusal names `temperature` and `reasoning-active`. Gateways at other origins need no change.
