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
| 笔记 | id、文本，以及至少一条引用：章节 id 加该章节最近一次被读取的文本的哈希，或 `ref:` 证据指针 |
| 待处理笔记 | 由 `context_note` 提交、等待策展者处理的文本 |
| 核心 | 树在每次对话开始时授予的章节 id，受树的 `coreBytes` 预算限制 |

如果笔记所引用的章节发生变化或消失，该笔记即为过期：其分组摘要会标明这一点，直到策展者重新阅读来源并确认或删除它。章节引用携带索引最近一次为该章节返回的文本的哈希，无人读取时则为索引中的哈希，因此策展者读取之后文件被编辑，新笔记会立即成为过期笔记。笔记不能引用笔记。每次编辑都携带其所基于的修订号，基于旧修订号的编辑会以 `CONTEXT_MAP_CONFLICT` 失败。

### 策展者角色

该角色是记录在日志中的持久授权，依据发起调用的确切存活智能体检查，而不是依据传入的 Session id。每张地图的持有者恰好一个；反向持有者索引在加载时从已准备的活动 Session 投影重建，并在智能体创建和地图提交时更新。持有者可以策展多张地图；策展工具通过 `root_session_id`、服务编辑通过 `rootSessionId` 选择其他对话的地图。省略目标始终选择调用者自己的根对话，即使调用者持有其他地图也是如此。持有者销毁时释放其持有的全部地图。`claim` 替换前任持有者并记录交接；带 `expectedHolder` 时只替换该持有者（未被领取的地图为 `null`），否则以 `CONTEXT_MAP_CONFLICT` 失败。`claim` 在读取索引之后、紧接提交之前检查其信号和 `expectedHolder`，因此被取消的领取既不会替换更新的持有者，也不计为一次尝试。`release` 放弃角色；所有者带 `unstartedWork` 时还会退还该工作最新的一次领取（其运行从未启动），该领取不再计为尝试。所有者以外的持有者，或该持有者启动的智能体，调用 `context_note` 会以 `CONTEXT_MAP_UNAUTHORIZED` 失败并指向 `map_note`：持有者自己提交它发现的内容，它自己的待处理笔记会成为它下一次运行的工作。未释放就消失的持有者会被记录为已离开，角色随即空出。策展者工具 `map_view`、`map_group`、`map_note` 和 `map_core` 只对持有者声明，且服务在执行时拒绝任何其他调用者，因此过期的工具集不会带来任何权限。这里没有任何包导入助手：以后的助手通过 `ctx.contextMap.claim` 接管该角色。

### 默认策展者

`DefaultContextCurator` 在有策展工作等待且没有其他智能体持有角色时启动一次运行，而不是每一步都运行。工作指上一次完成的运行尚未确认的上下文索引、待处理笔记、过期笔记，或工作智能体提交后因地图已满被拒绝的笔记。所有者的每一步只要发现等待中的工作，就用 `work-waiting` 变更宣告它，变更携带该工作的指纹和已记录的尝试次数；服务不记忆任何宣告，因此在领取之前启动失败的策展者会在所有者的下一步再次看到该工作。策展者在存活所有者旁加载时会立即检查每个所有者，因此其未加载期间已接受的工作无需所有者再走一步即可继续。地图在所有其他步骤钩子之后观察所有者的一步，其中包括上下文树的目录检查，并复用该检查刷新的索引；策展者依据宣告携带的工作作出判断。因此所有者的一步只刷新一次索引，也不读取地图视图。一次运行：

1. 从工作智能体的提供方中选择路线：窗口不小于 `minContextTokens` 的最小模型，使用其最低推理强度。模型目录不含价格，因此以此作为“便宜”的代理。该路线必须比工作智能体自己的路线更低（窗口更小，或窗口相同而工作智能体运行在高于其最低的强度）；否则记录 `CONTEXT_MAP_NO_CHEAP_ROUTE` 且策展者不运行，因为昂贵的策展者比没有策展者更糟；
2. 为预留的子 id 声明角色，并通过现有的子智能体服务启动子智能体，受 `maxSteps` 和 `maxTokens` 限制；
3. 在工作完成、达到步数上限、或其他持有者声明接管角色时结束（立即让出，仅在该持有者离开或释放角色后才重新启动）；
4. 销毁时取消尚未完成的目录读取并观察稍后的失败，在下一次运行或销毁之前释放角色并等待子智能体结束。

每个存活的地图所有者有一条生命周期记录，只有一个转换函数会改变其状态：

| 状态 | 含义 | 离开条件 |
|---|---|---|
| `idle` | 没有进行中的工作 | 触发 → `announced`；所有者或服务销毁 → `disposed` |
| `announced` | 检查地图：存活持有者、等待中的工作（取自所有者一步的宣告，否则读取一次）、已记录的尝试次数 | 符合条件的工作 → `claiming`；没有工作、存活持有者、`maxAttempts` 已用完、该工作和路线没有便宜路线、工作正在等待子智能体容量，或读取失败 → `idle`；销毁 → `disposed` |
| `claiming` | 选择路线、以 `expectedHolder: null` 领取、启动子智能体 | 已启动 → `running`；停止 → `yielding`；启动失败、被拒绝或被取消 → `settling` |
| `running` | 子智能体在角色下工作 | 停止 → `yielding`；子智能体结束 → `settling` |
| `yielding` | 已中止，等待启动或子智能体结束 | 结束 → `settling` |
| `settling` | 销毁子智能体、释放其仍持有的角色、确认已完成的索引 | 结束 → `idle`；所有者或服务已不在时 → `disposed` |
| `disposed` | 终止状态；记录被移除 | — |

触发是所有者某一步的宣告、提交或被拒绝的笔记、外部持有者离开、存活持有者释放角色、策展者在存活所有者旁加载，或某次运行让位给的持有者此后已离开。停止是另一持有者提交角色（`role moved`）、步数上限、所有者销毁或策展者销毁。运行期间提交的笔记或离开的持有者，仅在工作发生变化时，才会在该运行结束后再启动一次运行；所有者某一步的宣告不会，因此中断的运行由所有者的后续步骤重试。领取之前的启动失败使该工作在所有者下一步仍可启动，重复的失败只记录一次；`CONTEXT_MAP_NO_CHEAP_ROUTE` 在工作或所有者的路线改变之前不会重试。子智能体激活池因容量拒绝的启动（`ACTIVATION_LIMIT_REACHED`，例如 Workstream 成员占满池时）不算一次尝试：结算时退还其领取，同一工作在某个子智能体结束（`subagent/end`）时再次启动，而不是在所有者的步骤中重试；变化后的工作可以立即启动。所有者销毁会中止运行，并在运行结束后移除记录；同一 Session 的新智能体获得新记录。

领取返回 `observedIndexDigest`，但不会把索引标记为已策展。成功完成后，持有者或角色已释放地图的所有者用该摘要调用 `acknowledgeIndex`；其 `index-ack` 事件记录完成。步骤限制、错误、取消和重启保留原摘要。恢复时，没有 `index-ack` 的旧领取时摘要视为未完成。所有者的后续步骤或笔记可触发新尝试；中断的运行不会立即自行重试。运行期间索引发生变化时，完成后仍可再次策展。每次领取都会记录其所服务工作的指纹，回放时统计相同指纹的领取次数。因激活池拒绝启动而退还的领取不计数。对未变化的工作运行 `maxAttempts`（默认 2）次后，所有者的后续步骤和笔记不再启动运行，直到工作改变（新的索引摘要、新增待处理或过期笔记、已满地图的大小变化）。该计数保存在会话日志中，重启不会重置。助手持有角色期间为该工作发起的领取同样计数。

### 服务 API

```ts
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-experimental-context-map'

export async function curate(ctx: Context, assistant: Agent, owner: Agent) {
  await ctx.contextMap.claim(assistant, { holderId: assistant.id, rootSessionId: owner.id })
  const view = await ctx.contextMap.view(assistant, { rootSessionId: owner.id })
  await ctx.contextMap.setGroup(assistant, {
    rootSessionId: owner.id, expectedRevision: view.revision,
    group: { path: 'Tools/Global/shell', title: 'Shell tools', summary: 'Use when running commands.', tools: ['bash'] },
  })
}
```

服务还提供 `watch`、`curatedRoots`、`isCurator`、`curatorOf`、`snapshotOf`、`note`、`mergeGroups`、`retireGroup`、`addNote`、`verifyNote`、`retireNote`、`filePending`、`dropPending`、`setCore` 和 `curationWork`（等待中的 `CurationWork`：原因、指纹以及已为其记录的领取次数）。

### 工具

- `context_note(text, cites?)`，除所有者以外的持有者及其启动的智能体外，所有智能体可用：记录一条简短事实，返回待处理笔记 id 和等待中的笔记数。子智能体的笔记提交到它所属对话的地图。
- `map_view(pending_after?, group_after?, group_id?, note_after?)`、`map_group(action, …)`、`map_note(action, …)`、`map_core(sections)`，仅策展者可用。

视图将完整序列化结果计入预算。将 `nextPendingAfter` 作为 `pending_after` 继续待处理笔记，将 `nextGroupAfter` 作为 `group_after` 继续分组；如分组的笔记未列完，将其 id 作为 `group_id`，并将 `nextNoteAfter` 作为 `note_after` 继续。游标按 id 的字典序前进，即使之前的条目已归档、丢弃或退役也仍然有效。游标之前的新条目会在重新扫描时出现。分组页面不包含待处理笔记，因此满队列不会隐藏分组。每个分组的 `omittedNotes` 统计本页之后的笔记。如果元数据或单个条目无法容纳，则以 `CONTEXT_MAP_LIMIT` 失败；请增大 `maxViewBytes`。加载时，`maxViewBytes` 必须容纳页面元数据，以及按配置的文本和引用限制计算的最大待处理笔记，包括 JSON 转义。若编辑会使单个待处理笔记、分组头或分组笔记超出视图预算，则在写入日志前拒绝该编辑。满队列拒绝新笔记时会再次唤醒默认策展者。

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
| `maxSnapshotBytes` | 65536 | 将 `curatorId`、`route` 和 `indexDigest` 设为 null 后序列化的地图大小 |
| `maxViewBytes` | 8192 | `map_view` 返回的字节数 |

默认策展者另有 `provider`（`spawn`，进程内子智能体提供方）、`maxSteps`（24）、`maxTokens`（4096）、`minContextTokens`（32768）`maxRoutesInspected`（16）和 `maxAttempts`（2）。这些值是边界，选取依据是让完整地图落在一次视图内、让一次运行落在一次廉价模型调用预算内；它们没有针对特定负载调优。不可用的值会在加载时以 `CONTEXT_MAP_INVALID_CONFIG` 失败。

角色变更和索引确认是元数据操作，不受 `maxSnapshotBytes` 限制。每次内容编辑采用相同的排除元数据后的计量，因此释放角色不会为待处理笔记增加空间。满地图始终可被领取以缩减内容。因空间不足被拒绝的 `context_note` 会把地图标记为需要空间，直到下一次角色持有结束：`map_view` 此时带有 `needsSpace: true`，默认策展者启动一次运行，其提示要求它合并并清理直到有空间。该标记只在进程内存中，随所有者智能体结束；重启后工作智能体的重试会再次设置。服务还为每个存活所有者保存用于过期标记的章节哈希，并在所有者智能体销毁时丢弃。拒绝信息要求工作智能体缩短笔记或在空间释放后重试。

### 事件

本包新增事件类型 `context-map/state`。每条记录携带操作（`claim`、`release`、`index-ack`、`group-set`、`group-merge`、`group-retire`、`note-add`、`note-verify`、`note-retire`、`note-pending`、`note-file`、`pending-drop` 或 `core-set`）、执行操作的智能体，以及带连续修订号的完整地图快照。`claim` 记录其所服务的工作；记录了工作的 `release` 退还该工作中运行从未启动的那次领取。Session 投影把这些记录折叠回地图和尝试计数，遇到缺口即失败。Session 格式版本不变；见持久化变更记录 `2026-11-06-context-map-index-ack`。

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

树目录和 `context_browse` 把策展分组显示为文件夹，带有策展者的标题和摘要；含有过期笔记的分组在摘要之前显示过期标记，因此裁剪摘要时仍保留警告。已分组的章节不再显示其文件节点。已归档的笔记由策展者和助手通过 `map_view` 与 `snapshotOf` 读取；工作智能体只看到过期标记，看不到笔记文本。

#### Token 影响

标题和摘要在树现有的 `maxBrowseBytes` 之内取代原始的文件名和工具名。树的目录列出策展分组；某个分组出现、消失或改变摘要时会重新发布目录，每次变化最多一次；笔记和核心选择等其他地图编辑不会重新发布目录。

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
- **引用采用工作目录中最近一次读取**——索引为每个章节只记住一个最近读取的哈希，不区分读取者。如果另一个智能体在策展者提交笔记之前读取了编辑后的文本，引用会指向这份较新的文本，尽管策展者读的是旧文本。
- **策展者仍会看到 `context_note` 的声明**——上下文树把它作为基础工具声明给所有智能体；服务对持有者拒绝该调用，策展者提示词也说明了这一点。
- **没有跨对话的地图**——地图属于一个根 Session；新对话从空地图开始。
- **容量只通过结束的子智能体感知**——因激活容量被拒绝的工作等待 `subagent/end`。没有该事件就空出的槽位（启动时回滚的子智能体，或调高的 `maxActiveSubagents`）只有在另一个子智能体结束或工作改变时才会被使用。任何子智能体结束都会唤醒等待中的工作，包括其他根的池中的结束；唤醒时池仍满，会在所有者日志中留下一次领取及其退还。
- **尚无助手**——该角色为将来的 harness 助手而设计，但这里没有导入或提供任何助手。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

设计文档位于 context-grants 波次的编排存储中。本包为实验性，不提供稳定性承诺。它只依赖上下文树；树通过通用的注册接口（`registerCuratedGroups`、`registerEagerCore`、`registerManagedTools`）了解地图，从不导入地图。

</details>
