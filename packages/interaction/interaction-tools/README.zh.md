---
description: "面向智能体的浏览器和桌面交互工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-interaction-tools

[English](README.md) | 中文

## 概述

本包通过 `ctx.interaction` 注册稳定的 `browser_*` 和 `desktop_*` 工具。只有对应提供方已为当前 Agent 就绪时，工具才会进入工具目录，因此没有提供方的 Host 不会暴露不可用工具或提示词段落。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

<a id="use-this-package"></a>
## 使用本包

在 `@deepseek-ai/dsh-interaction` 和一个提供方适配器之后挂载本包。支持的 Host 会由 Web 和 Desktop 组合自动挂载。

<a id="understand-the-implementation"></a>
## 实现说明

工具使用步骤级激活条件。对应提供方不可用时，浏览器和桌面模式会消失；提供方专用的兼容工具可以继续显示。

<a id="further-exploration"></a>
## 进一步阅读

- [交互服务](../interaction/README.zh.md)——提供方注册和 Agent 所有权。
- [浏览器操作](../../../docs/subsystems/browser-use.zh.md)——浏览器操作和 Session 所有权。
- [计算机操作](../../../docs/subsystems/computer-use.zh.md)——桌面操作和权限。

<a id="model-experience"></a>
## 模型体验

### 浏览器和桌面工具

#### 模型看到的内容

模型会看到稳定的 `browser_*` 和 `desktop_*` 名称及操作专用 JSON 输入。模型不会选择提供方，也不会收到提供方凭据。

#### Token 影响

接纳的工具定义和返回的操作数据会产生与其他 DSH 工具相同的数据相关请求成本。

#### KV Cache 影响

提供方可用性和模式不变时，工具定义的前缀保持稳定。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- 规范化浏览器适配器覆盖导航、观察、标签页、截图和封闭的操作集合；Stagehand 适配器还支持规范化操作和提取。后端提供超出共享表面的能力时，提供方专用工具仍可用。

<a id="dev-note"></a>
### 开发备注

UI 卡片和截图附件投影由对应的客户端和附件包负责；本包只注册面向模型的工具。
