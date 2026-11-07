---
description: "用一个实验性 profile 层启用 Context Index、上下文树及其浏览和加载工具，并保持急切加载的指令核心很小。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-context-profile

[English](README.md) | 中文

## 概述

`dsh-experimental-context-profile` 挂载 [Context Index](../context-index/README.zh.md) 和[上下文树](../context-tree/README.zh.md)，注册 `context_browse` 与 `context_load` 模型工具，挂载[项目地图](../context-map/README.zh.md)及其默认策展者和 `context_note` 工具，并把急切加载的指令文件限制为每条链 4096 字节。基础集之外的每个工具在模型加载之前都保持隐藏，已加载的内容在压缩时被撤销。本层默认不在插件列表中显示，只能添加到已初始化的 profile。

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

patch 在 `agent-instructions` 条目上设置 `maxBytes: 4096`，并插入六个条目：

| 条目 | 包 | 作用 |
|---|---|---|
| `context-index` | `@deepseek-ai/dsh-experimental-context-index` | 指令和文档文件的章节 |
| `context-tree` | `@deepseek-ai/dsh-experimental-context-tree` | 树、工具准入、可撤销授权 |
| `tool-context-tree` | `@deepseek-ai/dsh-experimental-context-profile/context-tree-tools` | 注册 `context_browse` 与 `context_load` |
| `context-map` | `@deepseek-ai/dsh-experimental-context-map` | 项目地图及其角色检查 |
| `tool-context-map` | `@deepseek-ai/dsh-experimental-context-profile/context-map-tools` | 注册 `context_note` 和仅策展者可用的地图工具 |
| `context-curator` | `@deepseek-ai/dsh-experimental-context-profile/context-curator` | 运行在更便宜路线上的后台默认策展者 |

树的默认值（包括基础工具列表）见[上下文树 README](../context-tree/README.zh.md#use-this-package)。用 `context-tree` 条目上的 `config:` patch 修改它们。

<a id="understand-the-implementation"></a>
## 理解实现

- [`cordis.patch.yml`](cordis.patch.yml) 是本层。
- [`src/context-tree-tools.ts`](src/context-tree-tools.ts) 把 `ContextTreeTools` 重新导出为默认导出，因为 Loader 只挂载默认导出。
- [`src/context-map-tools.ts`](src/context-map-tools.ts) 和 [`src/context-curator.ts`](src/context-curator.ts) 对 `ContextMapTools` 与 `DefaultContextCurator` 做同样的事。
- [`src/index.ts`](src/index.ts) 为空；本包没有自己的运行时。

[`tests/composition.spec.ts`](tests/composition.spec.ts) 用无密钥的脚本化模型，通过 Loader 启动一个 `dsh` 进程。它断言隐藏工具不在第一次请求中，在 `context_load` 之后的请求中被声明，压缩后再次消失，并且目录和激活消息出现在持久化的 Session 日志中。不启用本层的对照运行从第一次请求起就能看到所有工具。第二次运行通过同一个无密钥适配器同时脚本化工作智能体和策展者：策展者在较小的模型上以最低强度运行，Session 日志包含地图编辑，策展者的对话只在它自己的 Session 中，工作智能体的请求带有 `context_note` 但没有任何策展者工具。

<a id="model-experience"></a>
## 模型体验

### 上下文树工具与隐藏工具

#### 模型看到的内容

`context_browse` 和 `context_load` 的 schema、目录消息，以及加载之后的授权与激活消息，均见[上下文树的模型体验](../context-tree/README.zh.md#model-experience)。本层不增加自己的文本。使用随附 PTC 执行器时，只有 `run_code` 可直接调用；获准工具出现在 `tools:sdk` 及其程序绑定中。基础集之外的工具在加载后的下一步之前不会出现在这两处，压缩会同时撤销声明与绑定。正在运行的程序保留已获准的工具集。

#### Token 影响

本层从每次请求中移除尚未加载的非基础工具声明，并加入树和 `context_note` 的声明及目录；PTC 将这些声明渲染为生成的 SDK，原生执行则渲染工具 schema。地图策展不占用工作对话：它发生在策展者自己的 Session 中，使用更便宜的路线。4096 字节的指令上限缩短了急切加载的指令文本；被省略的部分仍可通过树中的 `Instructions` 获取。

#### KV 缓存影响

只要 patch 和已加载集合不变，工具列表和系统提示词前缀保持稳定。加载工具会使已声明工具列表从该工具的注册位置起发生变化；压缩照常替换更早的请求 token。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **仅可选启用**——没有任何已发布的 CLI、Web、SDK、ACP 或 Python profile 启用它。
- **粗粒度的急切核心**——`agent-instructions` 不支持章节选择，因此本层把每条指令链的全部文本限制为 4096 字节，并带省略标记。要得到精心策划的小核心，需要修改该包。
- **策展者路线**——默认策展者需要工作智能体所在提供方中一个比工作智能体路线更低的模型；没有时它记录 `CONTEXT_MAP_NO_CHEAP_ROUTE` 且不运行。见[上下文地图的限制](../context-map/README.zh.md#known-limitations-and-deferred-work)。
- **需要 base profile**——patch 依赖 `dsh-base` 提供的服务。
- **工具来源**——见[上下文树的限制](../context-tree/README.zh.md#known-limitations-and-deferred-work)；每个工具都在 `Tools/Global` 下。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

无。

</details>
