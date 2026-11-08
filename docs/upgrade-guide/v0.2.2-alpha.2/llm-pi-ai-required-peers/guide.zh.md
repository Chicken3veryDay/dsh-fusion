---
kind: upgrade-guide
description: "`@deepseek-ai/dsh-llm-pi-ai` 新增必需 peer：`@deepseek-ai/dsh-agent` 与 `@deepseek-ai/dsh-credentials-local`。"
---

# `dsh-llm-pi-ai` 新增两个必需 peer

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-llm-pi-ai` 在必需的 `peerDependencies` 中新增 `@deepseek-ai/dsh-agent` 与 `@deepseek-ai/dsh-credentials-local`。插件加载时会导入 `dsh-credentials-local`，即使 profile 没有 `accounts` 也是如此；`dsh-agent` 提供代理请求错误事件的类型。

通过 `dsh` profile 安装已包含这两个包，无需操作。自行安装插件 peer 的使用方，例如自定义宿主、SDK 运行时，或不会自动安装 peer 的包管理器，现在在两个包都无法解析之前会在安装或加载时失败。新增的 `accounts` profile 键是可选的，不改变任何现有 profile。

## 迁移

1. 将 `@deepseek-ai/dsh-agent` 与 `@deepseek-ai/dsh-credentials-local` 加入宿主的依赖，版本与其他 `@deepseek-ai/dsh-*` 包一致。
2. 重新安装，确认包管理器不再报告 `@deepseek-ai/dsh-llm-pi-ai` 缺少 peer。
3. 启动宿主，确认 `llm-pi-ai` 插件加载时没有 module-not-found 错误。
