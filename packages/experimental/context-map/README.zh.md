---
description: "由智能体维护的项目地图：对上下文章节、工具和带引用的笔记进行分组，只有策展者角色持有者可以编辑，并附带零配置的后台默认策展者，面向组合精简上下文 profile 的开发者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-context-map

[English](README.md) | 中文

## 概述

上下文地图记录项目的指令、文档和工具如何归属在一起：有名称的分组，每组带一行摘要；还有引用来源的简短笔记。[上下文树](../context-tree/README.zh.md)显示这些分组，并在对话开始时授予地图核心章节。只有策展者角色的持有者可以编辑地图。后台默认策展者持有该角色，除非其他持有者声明接管；它在更便宜的模型路线上运行，其对话记录不进入工作对话。工作智能体只获得一个工具 `context_note`。无需配置。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

先挂载[上下文树](../context-tree/README.zh.md)及其工具，再挂载本包（默认导出 `ContextMapService`），然后挂载 `ContextMapTools`，并可选挂载 `DefaultContextCurator`。后两者都要通过把它们重新导出为默认导出的模块挂载，因为 Loader 只挂载默认导出。[profile 层](../context-profile/README.zh.md)提供这些模块，并为 profile 挂载全部内容。没有任何已发布的 profile 挂载本包。

### 地图

| 记录 | 内容 |
|---|---|
| 分组 | id、路径 `Root/Origin/name`（`Instructions`、`Sources` 或 `Tools`；`Global` 或 `Project`）、标题、一行摘要、成员章节 id、成员工具名、笔记 |
| 笔记 | id、文本，以及至少一条引用：读取时的章节 id 加内容哈希，或 `ref:` 证据指针 |
| 待处理笔记 | 由 `context_note` 提交、等待策展者处理的文本 |
| 核心 | 树在每次对话开始时授予的章节 id，受树的 `coreBytes` 预算限制 |

如果笔记所引用的章节发生变化或消失，该笔记即为过期：其分组摘要会标明这一点，直到策展者重新阅读来源并确认或删除它。笔记不能引用笔记。每次编辑都携带其所基于的修订号，基于旧修订号的编辑会以 `CONTEXT_MAP_CONFLICT` 失败。

### 策展者角色

该角色是记录在日志中的持久授权，依据发起调用的确切存活智能体检查，而不是依据传入的 Session id。持有者恰好一个。`claim` 替换前任持有者并记录交接；`release` 放弃角色。未释放就消失的持有者会被记录为已离开，角色随即空出。策展者工具 `map_view`、`map_group`、`map_note` 和 `map_core` 只对持有者声明，且服务在执行时拒绝任何其他调用者，因此过期的工具集不会带来任何权限。这里没有任何包导入助手：以后的助手通过 `ctx.contextMap.claim` 接管该角色。

### 默认策展者

`DefaultContextCurator` 在上下文索引变化或有笔记提交时启动一次运行，而不是每一步都运行。一次运行：

1. 从工作智能体的提供方中选择路线：窗口不小于 `minContextTokens` 的最小模型，使用其最低推理强度。模型目录不含价格，因此以此作为“便宜”的代理。该路线必须比工作智能体自己的路线更低（窗口更小，或窗口相同而工作智能体运行在高于其最低的强度）；否则记录 `CONTEXT_MAP_NO_CHEAP_ROUTE` 且策展者不运行，因为昂贵的策展者比没有策展者更糟；
2. 为预留的子 id 声明角色，并通过现有的子智能体服务启动子智能体，受 `maxSteps` 和 `maxTokens` 限制；
3. 在工作完成、达到步数上限、或其他持有者声明接管角色时结束（立即让出，仅在该持有者离开后才重新启动）；
4. 在下一次运行之前或释放之前，总是先释放角色并等待子智能体结束。

### 服务 API

```ts
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-experimental-context-map'

export async function curate(ctx: Context, assistant: Agent, owner: Agent) {
  await ctx.contextMap.claim(assistant, { holderId: assistant.id, rootSessionId: owner.id })
  const view = await ctx.contextMap.view(assistant, { rootSessionId: owner.id })
  await ctx.contextMap.setGroup(assistant, {
    expectedRevision: view.revision,
    group: { path: 'Tools/Global/shell', title: 'Shell tools', summary: 'Use when running commands.', tools: ['bash'] },
  })
}
```

服务还提供 `watch`、`isCurator`、`curatorOf`、`snapshotOf`、`note`、`mergeGroups`、`retireGroup`、`addNote`、`verifyNote`、`retireNote`、`filePending`、`dropPending` 和 `setCore`。

### 工具

- `context_note(text, cites?)`，所有智能体可用：记录一条简短事实，返回待处理笔记 id 和等待中的笔记数。子智能体的笔记提交到它所属对话的地图。
- `map_view()`、`map_group(action, …)`、`map_note(action, …)`、`map_core(sections)`，仅策展者可用。

### 配置

每个字段都有默认值。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxGroups` | 32 | 地图中的分组数 |
| `maxGroupMembers` | 32 | 一个分组中章节与工具的总数 |
| `maxNotesPerGroup` | 8 | 一个分组中已归档的笔记数 |
| `maxCitesPerNote` | 4 | 一条笔记的引用数 |
| `maxNoteBytes` | 400 | 笔记文本的字节数 |
| `maxEvidenceBytes` | 200 | `ref:` 证据指针的字节数 |
| `maxPendingNotes` | 16 | 等待策展者的笔记数 |
| `maxTitleBytes` | 80 | 分组标题的字节数 |
| `maxSummaryBytes` | 160 | 分组摘要的字节数 |
| `maxCoreSections` | 8 | 核心中的章节数 |
| `maxSnapshotBytes` | 65536 | 序列化后的地图大小 |
| `maxViewBytes` | 8192 | `map_view` 返回的字节数 |

默认策展者另有 `provider`（`spawn`，进程内子智能体提供方）、`maxSteps`（24）、`maxTokens`（4096）、`minContextTokens`（32768）和 `maxRoutesInspected`（16）。这些值是边界，选取依据是让完整地图落在一次视图内、让一次运行落在一次廉价模型调用预算内；它们没有针对特定负载调优。不可用的值会在加载时以 `CONTEXT_MAP_INVALID_CONFIG` 失败。

### 事件

本包新增事件类型 `context-map/state`。每条记录携带操作（`claim`、`release`、`group-set`、`group-merge`、`group-retire`、`note-add`、`note-verify`、`note-retire`、`note-pending`、`note-file`、`pending-drop` 或 `core-set`）、执行操作的智能体，以及带连续修订号的完整地图快照。Session 投影把这些记录折叠回地图，遇到缺口即失败。Session 格式版本不变；见持久化变更记录 `2026-11-06-context-map-state`。

<a id="understand-the-implementation"></a>
## 理解实现

- [`src/types.ts`](src/types.ts) 包含地图记录、请求和配置类型。
- [`src/projection.ts`](src/projection.ts) 是 Session 投影以及事件的严格模式。
- [`src/edits.ts`](src/edits.ts) 包含纯编辑规则：路径解析、成员与引用检查、哈希和过期判断。
- [`src/index.ts`](src/index.ts) 是服务：修订号检查、角色检查、提交、对索引变化的观察，以及通过树的策展分组、急切核心和受管工具接口向树注册。
- [`src/tools.ts`](src/tools.ts) 注册模型工具。[`src/route.ts`](src/route.ts) 选择策展者路线。[`src/curator.ts`](src/curator.ts) 是默认策展者。

服务每次编辑提交一个事件：先追加、再刷新，之后才更新缓存的地图并通知观察者。笔记是否过期，由其引用中保存的内容哈希与当前索引的哈希计算得出，因此没有后台任务来决定。地图属于一条谱系的根 Session。子智能体把笔记提交到其根，策展者子智能体从不获得自己 Session 的地图。

<a id="model-experience"></a>
## 模型体验

### 上下文笔记工具

#### 模型看到的内容

一个工具模式 `context_note`，描述见 [`src/tools.ts`](src/tools.ts)。它返回待处理笔记 id 和等待中的笔记数。策展者工具不会出现在工作智能体的请求中。

#### Token 影响

一个工具的固定模式开销，加上模型写的笔记文本。

#### KV 缓存影响

该模式位于已声明的工具之中，并且是基础工具，因此属于稳定前缀。一次调用追加一条简短的工具调用和结果。

### 树中的地图分组

#### 模型看到的内容

树目录和 `context_browse` 把策展分组显示为文件夹，带有策展者的标题和摘要；含有过期笔记的分组带过期标记。已分组的章节不再显示其文件节点。已归档的笔记由策展者和助手通过 `map_view` 与 `snapshotOf` 读取；工作智能体只看到过期标记，看不到笔记文本。

#### Token 影响

标题和摘要在树现有的 `maxBrowseBytes` 之内取代原始的文件名和工具名。地图变化时树会重新发布目录，每次变化最多一次。

#### KV 缓存影响

与树目录一样仅追加：目录变化即追加一条消息。急切核心在对话开始时授予一次，压缩之后再授予一次，受 `coreBytes` 限制。

### 策展者运行

#### 模型看到的内容

什么也看不到。策展者在自己的 Session 中运行；工作对话既收不到它的提示，也收不到它的工具调用。工作智能体的 Session 日志只包含 `context-map/state` 记录。

#### Token 影响

工作对话中为零。策展者自身的 token 记在它更便宜的路线上。

#### KV 缓存影响

对工作对话没有影响。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **没有价格元数据**——模型目录不含价格，因此“便宜”是有文档说明的代理（足够大的最小窗口、最低强度、且低于工作智能体的路线）。如果该代理在某个部署中不成立，需要由该部署自己的智能体来声明角色。
- **只看一个提供方**——路线选择只查看工作智能体的提供方。
- **在步骤中才发现索引变化**——变化在根智能体的下一步才被发现，而不是文件写入时。
- **工具成员按名称**——分组记录工具名；工具被重命名或移除后，成员保持过期，直到策展者编辑该分组。
- **压缩之后的丢弃章节**——上下文树保留它重新发布的已撤销章节列表，受 `maxDroppedBytes` 限制。第二次压缩仍会把先前的撤销存根并入摘要，修复需要修改压缩。
- **笔记不显示给工作智能体**——树显示分组和过期标记，不显示笔记文本，因此已归档的笔记对策展者和以后的助手有用，但目前不会进入工作对话。显示笔记文本需要带有自己 Session 事件的模型可见授权。
- **没有跨对话的地图**——地图属于一个根 Session；新对话从空地图开始。
- **尚无助手**——该角色为将来的 harness 助手而设计，但这里没有导入或提供任何助手。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

设计文档位于 context-grants 波次的编排存储中。本包为实验性，不提供稳定性承诺。它只依赖上下文树；树通过通用的注册接口（`registerCuratedGroups`、`registerEagerCore`、`registerManagedTools`）了解地图，从不导入地图。

</details>
