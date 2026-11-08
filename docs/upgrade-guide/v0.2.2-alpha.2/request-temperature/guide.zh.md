---
kind: upgrade-guide
description: "官方 DeepSeek 路由在启用推理时拒绝已提供的 temperature。"
---

# 官方 DeepSeek 在推理时拒绝 temperature

[English](guide.md) | 中文

## 变更

DeepSeek 文档说明，官方服务在 thinking 模式下将 temperature 固定为 1.0。`@deepseek-ai/dsh-llm-deepseek` 此前把每个已提供的控制项都报告为受支持，并发送会被忽略的值。当调用捕获的连接指向官方源，且其强度（或连接默认值）不是 `off` 时，调用现在会在凭据、请求头或 HTTP 工作之前以 `UNSUPPORTED_CONTROL` 失败，并带有 `unsupportedControl: { control: 'temperature', reason: 'reasoning-active' }`。使用 `off` 或 `thinking: disabled` 时仍会发送该值。其他源把 `temperature` 报告为 `unverified`（`protocol-unverified`），并照常发送。线路请求不变。

没有 `ConfigureCall` 回调的调用会在路由捕获连接之前，依据适配器的同步连接事实被拒绝，因此无论模型列表是冷的还是已填充的，都不会出现凭据读取、请求头或请求。带有 `ConfigureCall` 回调的调用在回调依据所跟随的列表恰好运行一次（可添加、删除或修改 `temperature` 或推理）之后再判定；发现用凭据与列表请求可能先于拒绝发生，推理用凭据、请求头与请求则不会。由于提前结论优先，官方源上无效的 temperature 会先于列表将拒绝的模型被报告。不带该 temperature 或推理为 `off` 的调用保留列表给出的 `MODEL_UNSUPPORTED` 与 `CLIENT_UPGRADE_REQUIRED` 结论，模型未提供的强度仍以 `UNSUPPORTED_REASONING_EFFORT` 失败。

## 迁移

1. 对于指向官方路由且启用推理的调用，从调用方、扩展或 `agent/request` 监听器中移除 `temperature`，或为这些调用选择 `reasoningEffort: off`。
2. 运行调用，确认其完成，或确认拒绝信息指明 `temperature` 与 `reasoning-active`。其他源的网关无需更改。
