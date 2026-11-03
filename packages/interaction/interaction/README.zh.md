---
description: "面向智能体的浏览器和桌面交互能力。"
kind: "package-reference"
---

# @deepseek-ai/dsh-interaction

[English](README.md) | 中文

## 概述

交互服务是 DSH 自有的浏览器和桌面控制能力接缝。提供方按域注册适配器；服务负责精确 Agent 资源、串行执行、取消和清理。传输和原生权限实现保留在提供方内部。

本包不保存浏览器 Cookie、桌面状态、凭据或截图。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

<a id="use-this-package"></a>
## 使用本包

在一个浏览器或桌面适配器旁挂载服务。本服务不保存浏览器 Cookie、桌面状态、凭据或截图。

<a id="understand-the-implementation"></a>
## 实现说明

提供方通过 effect 注册适配器。服务为每个精确 Agent 打开一个活动资源，为该 Agent 串行执行操作，并在 Agent 或提供方释放时关闭资源。重放 Session 不会重新打开活动资源。

<a id="further-exploration"></a>
## 进一步阅读

- [浏览器操作](../../../docs/subsystems/browser-use.zh.md)——浏览器适配器和规范化操作。
- [计算机操作](../../../docs/subsystems/computer-use.zh.md)——桌面适配器和 Host 权限。

<a id="model-experience"></a>
## 模型体验

### 能力可用性

#### 模型看到的内容

Agent 只会收到当前提供方可用性接纳的规范化 `browser_*` 和 `desktop_*` 工具。提供方名称和设置诊断保留为 Host 元数据。

#### Token 影响

本能力本身不添加工具模式；提供方就绪时由配套的 interaction-tools 包提供工具定义。

#### KV Cache 影响

提供方可用性会改变进入请求的交互工具模式；提供方目录不变时，可复用的请求前缀保持稳定。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- 本服务不提供提供方实现、操作系统权限流程或可持久化的浏览器和桌面状态；这些责任由适配器承担。

<a id="dev-note"></a>
### 开发备注

稳定能力有意小于任何上游浏览器或桌面目录。提供方专用操作保留在适配器边界以下。
