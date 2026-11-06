---
description: "用一个实验性 profile 层启用 Context Index、上下文树及其浏览和加载工具，并保持急切加载的指令核心很小。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-context-profile

[English](README.md) | 中文

## 概述

`dsh-experimental-context-profile` 挂载 [Context Index](../context-index/README.zh.md) 和[上下文树](../context-tree/README.zh.md)，注册 `context_browse` 与 `context_load` 模型工具，并把急切加载的指令文件限制为每条链 4096 字节。基础集之外的每个工具在模型加载之前都保持隐藏，已加载的内容在压缩时被撤销。本层默认不在插件列表中显示，只能添加到已初始化的 profile。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 安装到 profile

```sh
dsh plugin --profile headless add @deepseek-ai/dsh-experimental-context-profile
dsh --profile headless "Browse the context tree and load the ticket tools."
```

profile 必须已经包含 `@deepseek-ai/dsh-base`，本层会使用其中的工具、压缩与 Session 服务。执行 `dsh plugin --profile <name> remove @deepseek-ai/dsh-experimental-context-profile` 移除本层。

### 获得的功能

patch 在 `agent-instructions` 条目上设置 `maxBytes: 4096`，并插入三个条目：

| 条目 | 包 | 作用 |
|---|---|---|
| `context-index` | `@deepseek-ai/dsh-experimental-context-index` | 指令和文档文件的章节 |
| `context-tree` | `@deepseek-ai/dsh-experimental-context-tree` | 树、工具准入、可撤销授权 |
| `tool-context-tree` | `@deepseek-ai/dsh-experimental-context-profile/context-tree-tools` | 注册 `context_browse` 与 `context_load` |

树的默认值（包括基础工具列表）见[上下文树 README](../context-tree/README.zh.md#use-this-package)。用 `context-tree` 条目上的 `config:` patch 修改它们。

<a id="understand-the-implementation"></a>
## 理解实现

- [`cordis.patch.yml`](cordis.patch.yml) 是本层。
- [`src/context-tree-tools.ts`](src/context-tree-tools.ts) 把 `ContextTreeTools` 重新导出为默认导出，因为 Loader 只挂载默认导出。
- [`src/index.ts`](src/index.ts) 为空；本包没有自己的运行时。

[`tests/composition.spec.ts`](tests/composition.spec.ts) 用无密钥的脚本化模型，通过 Loader 启动一个 `dsh` 进程。它断言隐藏工具不在第一次请求中，在 `context_load` 之后的请求中被声明，压缩后再次消失，并且目录和激活消息出现在持久化的 Session 日志中。不启用本层的对照运行从第一次请求起就能看到所有工具。

<a id="model-experience"></a>
## 模型体验

### 上下文树工具与隐藏工具

#### 模型看到的内容

`context_browse` 和 `context_load` 的 schema、目录消息，以及加载之后的授权与激活消息，均见[上下文树的模型体验](../context-tree/README.zh.md#model-experience)。本层不增加自己的文本。基础集之外的工具在加载之前不会被声明。

#### Token 影响

本层从每次请求中移除所有非基础工具的 schema，并加入两个树 schema 和目录。4096 字节的指令上限缩短了急切加载的指令文本；被省略的部分仍可通过树中的 `Instructions` 获取。

#### KV 缓存影响

只要 patch 和已加载集合不变，工具列表和系统提示词前缀保持稳定。加载工具会使已声明工具列表从该工具的注册位置起发生变化；压缩照常替换更早的请求 token。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **仅可选启用**——没有任何已发布的 CLI、Web、SDK、ACP 或 Python profile 启用它。
- **粗粒度的急切核心**——`agent-instructions` 不支持章节选择，因此本层把每条指令链的全部文本限制为 4096 字节，并带省略标记。要得到精心策划的小核心，需要修改该包。
- **需要 base profile**——patch 依赖 `dsh-base` 提供的服务。
- **工具来源**——见[上下文树的限制](../context-tree/README.zh.md#known-limitations-and-deferred-work)；每个工具都在 `Tools/Global` 下。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

无。

</details>
