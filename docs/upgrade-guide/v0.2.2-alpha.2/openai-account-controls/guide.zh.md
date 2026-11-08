---
kind: upgrade-guide
description: "OpenAI Responses 会拒绝其绑定账户省略的已选控制项。"
---

# OpenAI 账户控制项

[English](guide.md) | 中文

## 变更

向 `https://api.openai.com/v1` 发送并使用会话形态有效凭据的 OpenAI Responses 调用，会对已提供的 `temperature` 和 `maxTokens` 返回 `UNSUPPORTED_CONTROL` 及 `account-omits`。此前 pi-ai 静默省略这些字段。配置的模型默认值也视为已提供的控制项。拒绝发生在准备阶段、请求头或助手输出记录之前；循环保留用于诊断的用户输入。 准备期间发现的临时认证故障保留正常请求流的重试处理。每个新尝试重新解析认证；失败的准备操作绝不会重复解析。认证策略拒绝与取消仍立即生效。

## 迁移

1. 使用受影响账户时，从调用或路由的模型默认值中移除 `temperature` 与 `maxTokens`。
2. 若必须使用这些控制项，显式配置兼容的 API 密钥路由。Harness 不会自动切换计费或修改存储账户。
3. 确认准备成功并检查该路由上的请求。旧有 `maxTokens` 仍是带有 pi-ai 最小值和上下文钳制行为的额度，并非新增的总量硬上限。

准备好的进行中调用在退出登录后仍保留捕获的凭据。退出登录后，新的仅限存储凭据调用会拒绝，而不会回退到环境凭据。持久化分类记录在[确认记录](../../../persistence-changes/2026-11-08-openai-account-omits.zh.md)中。
