---
description: "一棵可浏览的指令、参考文档与工具树，智能体按需加载，压缩时撤销，面向组合精简上下文 profile 的开发者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-context-tree

[English](README.md) | 中文

## 概述

上下文树给智能体一小组始终可见的工具，以及一棵装着其余所有内容的树。根节点是 `Instructions`、`Sources` 和 `Tools`，每个又分为 `Global` 和 `Project`。模型用 `context_browse` 浏览标题和一行“何时使用”摘要，再调用 `context_load`，把指令或来源文本加入对话，或让一组隐藏工具从下一步起可调用。压缩会撤销已加载的文本和已激活的工具，并重新发布目录。本服务不调用模型，也不需要配置。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在工具注册表、压缩和 Session 投影服务之后，依次挂载 `@deepseek-ai/dsh-experimental-context-index`、本包（默认导出 `ContextTreeService`），再通过一个把具名导出 `ContextTreeTools` 重新导出为默认导出的模块挂载它，因为 Loader 只挂载默认导出（profile 层提供了这样的模块）。[profile 层](../context-profile/README.zh.md)为 profile 完成这些挂载。没有任何已发布的 profile 挂载本包。

### 树结构

| 根 | Global | Project |
|---|---|---|
| `Instructions` | 用户全局指令文件的章节 | 项目指令文件的章节 |
| `Sources` | 空；没有索引来源属于全局文档 | 项目文档根目录下的 Markdown |
| `Tools` | 以 `global` 或未记录来源注册的工具 | 以 `project` 来源注册的工具，或由提示或分配器放入 `Project` 的工具 |

来源由文件或注册的出处决定，绝不由名称决定。文件的来源取自上下文索引的 source。已注册工具的来源取自其注册记录（`ctx.tools.originOf`），由读取配置层的生产方写入：`origin: project` 的 MCP 服务器或 ACP 会话服务器会把其工具放在 `Project` 下，`origin: global` 则放在 `Global` 下。提示或分配器可以覆盖它。注册时没有记录来源的工具读作 `unknown`，仍放在 `Global` 下，并由 `unresolvedToolOrigins` 列出。工具分组来自 `registerToolGroup` 提示，否则来自工具名：`mcp__<server>__*` 成为分组 `mcp-<server>`，至少两个工具共享的首个 `_` 之前的前缀成为该分组，其余进入 `other`。

路径是节点各段用 `/` 连接，与 `context_browse` 打印的一致，例如 `Tools/Global/probe`。段内的 `%` 或 `/`（例如 `$DSH_HOME/AGENTS.md` 中的 `/`）写作 `%25` 或 `%2F`。 `context_load` 还接受独立于当前分组的裸章节 id 或 `Tools/@/<编码后的工具名>`。重新分组后，已记录的章节路径按末尾章节 id 解析。工具压缩存根和已丢弃目录使用稳定工具地址；保留的激活记录也可解析先前的分组路径。

### 工具

- `context_browse(path?, depth = 1, offset = 0)` 列出子节点的路径、标题和摘要。深度受 `maxBrowseDepth` 限制；超过 `maxBrowseNodes` 或 `maxBrowseBytes` 的列表末尾会给出继续用的 offset。
- `context_load(paths)` 加载所列的每个节点，或某个文件夹下的每个节点。一次调用中的所有加载构成一次变更。

### 服务 API

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-experimental-context-tree'

export function placeTools(ctx: Context) {
  const group = ctx.contextTree.registerToolGroup({ origin: 'project', group: 'tickets', prefix: 'ticket_', summary: 'Use for work-board tickets.' })
  const placement = ctx.contextTree.registerToolPlacement(tool => (tool.name.startsWith('lint_') ? { origin: 'project', group: 'lint' } : undefined))
  return async () => { await group(); await placement() }
}
```

两者都返回该注册的释放函数。`registerToolPlacement` 是策展者重新分组工具的接口：分配器返回一个位置或 `undefined`。服务还提供 `browse`、`load`、`activeTools`、`isBaseTool` 和 `unresolvedToolOrigins`。

### 策展者接口

三个通用注册接口让策展者塑造树，而树无需导入它；[上下文地图](../context-map/README.zh.md)使用它们。

- `registerCuratedGroups(provider)`：针对某个智能体返回分组（`root`、`origin`、`name`、`title`、`summary`、成员 `sections` 和 `tools`）。策展分组是带有自己标题和摘要的文件夹节点。其章节不再显示文件节点，其工具的位置优先于提示和名称。
- `registerEagerCore(provider)`：返回树在对话开始时授予一次、压缩之后再授予一次的章节 id，作为普通的已记录授权，受 `coreBytes` 限制。放不进剩余字节的章节被跳过，绝不只授予一部分，其后更小的章节仍可放入。
- `registerManagedTools(names, admit)`：只有 `admit` 接受的智能体才能看到的工具，在工具准入中强制执行。

### 配置

所有字段都有默认值。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `baseTools` | `read`、`read_image`、`write`、`edit`、`apply_patch`、`glob`、`grep`、`bash`、`web_search`、`web_fetch`、`todo_write`、`skill`、`context_browse`、`context_load`、`context_note` | 始终声明的工具；未注册的名称不会出现，且两个树工具总会被加入 |
| `maxBrowseDepth` | 3 | 一次浏览可列出的最深层级 |
| `maxBrowseNodes` | 64 | 一次列表中的节点数 |
| `maxBrowseBytes` | 8192 | 一次列表渲染后的字节数 |
| `maxLoadPaths` | 16 | 一次加载调用中的路径数 |
| `maxLoadBytes` | 32768 | 一次加载加入的章节字节数 |
| `maxActivatedTools` | 32 | 一次加载可激活的工具数 |
| `maxSummaryBytes` | 160 | 节点摘要的字节数 |
| `maxDroppedBytes` | 1024 | 重新发布的目录在后续压缩之间保留的已撤销章节列表的字节数 |
| `coreBytes` | 4096 | 急切核心提供方在对话开始时可授予的章节字节数 |

不可用的值会在加载时以 `CONTEXT_TREE_INVALID_CONFIG` 失败。 浏览结果保留完整路径，仅在需要满足 `maxBrowseBytes` 时裁剪显示标题中的路径。部分章节授权可以重新加载；只有完整授权才抑制重复加载。急切授权在 Session 来源中记录其字节费用。所有仍持有的急切授权，包括之前的选择以及已排队或已认领的授权，都会持续占用 `coreBytes`，直到撤销。更改核心不能在压缩前再累积一整份预算；通过显式加载已持有的选中章节也会占用预算。较早的授权没有记录费用，无法区分其来自急切授予还是显式加载，因此会将新的急切授权推迟到撤销之后。

### 事件

本包不新增事件类型。它使用现有的 `user/message` 事件和三种来源类型：`context-tree-catalog`（已发布的树）、`context-grant`（已加载的章节文本）和 `context-activation`（已可调用的工具）。`context-grant` 和 `context-activation` 被注册为可撤销的压缩来源。pre-step 发布器与 `system-prompt/request-context` 共用这些消息：请求阶段压缩后，在发送前恢复缺失的目录与急切核心消息。请求阶段的钩子把已接受的待提交消息中的急切授权计入 `coreBytes` 并视为已持有，因此两个钩子不会在一次请求中授予两份预算。若本步骤的待提交消息已带有目录，则不再追加第二份目录；此后的压缩只是把条目移入已丢弃列表，压缩留在历史中的存根会在该请求中指明它们。被压缩移除的核心章节仍会在该请求中于 `coreBytes` 内重新授予。本次请求重新授予的章节不会出现在已丢弃列表中。循环在派生请求前把所有新增消息提交到 Session 日志。

<a id="understand-the-implementation"></a>
## 理解实现

- [`src/types.ts`](src/types.ts) 包含类型，包括消息来源的形状。
- [`src/tree.ts`](src/tree.ts) 根据上下文索引快照和工具注册表构建树，并完成来源放置与分组。 已记录的工具来源优先于冲突的放置提示；来源未知时可以指定。策展文件夹与文件路径相同时，同一地址也包含该文件未分组的章节。
- [`src/paths.ts`](src/paths.ts) 编码并拆分路径；[`src/render.ts`](src/render.ts) 渲染浏览和加载结果；[`src/messages.ts`](src/messages.ts) 构造目录、授权和激活消息。
- [`src/projection.ts`](src/projection.ts) 是 Session 投影，从日志推导已加载章节、激活和已发布目录。 只有章节不再有保留的授权时，压缩才会将其列为已丢弃。服务将已记录的候选项与 Session 当前表面相交，因此任何表面替换都允许重新加载已移除的章节，并撤销已移除的工具激活。
- [`src/index.ts`](src/index.ts) 是服务：准入策略、pre-step 目录钩子、可撤销来源、浏览与加载。
- [`src/tools.ts`](src/tools.ts) 注册两个模型工具。

工具准入从请求中移除工具并为其余工具排序。它按配置顺序保留 `baseTools`，因此重新加载的提供方不会移动其工具，再按激活顺序保留投影报告为活跃的每个工具。激活顺序由已记录的激活消息推导，因此声明可以由会话日志重建。模型仍然调用的隐藏工具在分发时以未知工具失败。一步的准入发生在该步领取收件箱之后、已领取消息写入日志之前，因此投影还会跟踪持久的收件箱拼接：激活从入队的那一刻起算，经过领取，直到已记录的消息接手。这使工具无需修改 agent loop 即可在下一次请求中可调用。

策展者管理的工具追加在已激活工具之后，因此获得角色会保留原有声明前缀。重新发布的目录从已丢弃列表中排除当前激活的工具，即使这些工具是从原分组中单独重新加载的。

每一步之前，服务渲染目录，当其摘要与投影中的不同时追加一条目录消息。压缩移除了先前的目录后，新目录会说明它替换任何早先的列表。

<a id="model-experience"></a>
## 模型体验

### 上下文树工具

#### 模型看到的内容

两个工具 schema：`context_browse` 和 `context_load`，描述见 [`src/tools.ts`](src/tools.ts)。`context_browse` 返回由路径、标题和摘要组成的行，列表被截断时还返回继续用的 offset。`context_load` 返回哪些路径已授权、已激活、已加载、已处于活跃、缺失或因大小被省略。不在 `baseTools` 中且未被激活的工具不会出现在请求里。

#### Token 影响

两个 schema 带来固定成本。其他所有工具 schema 在加载前都被移除，这就是节省之处。一次浏览最多增加 `maxBrowseBytes`；一次加载增加最多 `maxLoadBytes` 的章节文本和一行激活消息。

#### KV 缓存影响

工具声明位于请求前缀中，因此移除隐藏工具会使前缀一次性缩短。一次激活追加一条消息，并把该工具声明在基础工具和更早的激活之后，因此其前面的声明保持不变，只有新增的尾部不在缓存中。激活保持到压缩为止，同一步中的多次加载构成一次变更，并按加载被记录的顺序追加。压缩本来就会替换更早的 token。

### 树目录

#### 模型看到的内容

一条用户消息 `<context_tree>`，包含根节点及其计数，在第一个模型步骤之前追加，压缩后再次追加。其文本取决于指令文件、文档和已注册工具。

#### Token 影响

受 `maxBrowseBytes` 限制。

#### KV 缓存影响

仅追加。只有树的摘要发生变化，或压缩移除了先前的目录时才会再次追加。

### 已加载章节与激活

#### 模型看到的内容

`<context-grant path=… section=… hash=…>` 消息保存已加载的章节文本。`<context-activation>` 消息列出现在可调用的工具及其来源节点。压缩后，一个有界的存根“Revoked context (reload if needed):”列出被撤销的内容。

#### Token 影响

每次加载最多 `maxLoadBytes` 的章节文本，保留到压缩为止，之后由不超过压缩存根上限的存根取代。

#### KV 缓存影响

压缩前仅追加增长，压缩照常替换更早的请求 token。执行压缩的那次请求仍会声明已激活的工具，因为工具集在压缩 pre-step 之前解析；声明在下一步才会消失。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **工具来源取决于生产方**——只有记录来源的生产方才会把工具放在 `Tools/Project` 下（`dsh-mcp-client` 和 ACP 会话服务器会）。其他注册读作 `unknown`，仍放在 `Tools/Global` 下，并在其生产方记录来源之前出现在 `unresolvedToolOrigins` 中。
- **技能不在树中**——`skill` 仍是基础工具。
- **压缩请求**——执行压缩的请求仍声明已激活的工具；声明在下一步消失。修复需要让工具集在压缩 pre-step 之后解析。
- **后续压缩**——第二次压缩会总结第一个检查点，因此更早的撤销存根被并入摘要。
- **重复授权**——完整授权已排队或已被领取但尚未写入日志的章节视为已加载，因此在这段时间内第二次加载不会再授权一次。
- **子智能体**——子智能体只从基础工具开始；不继承激活。
- **刷新成本**——上下文索引每一步都会重新 stat 指令和文档文件。
- **丢弃的章节**——第二次压缩会把更早的撤销存根并入摘要。树在投影状态中保留自己的已撤销章节列表（受 `maxDroppedBytes` 限制），并随目录重新发布，这缓解但没有修复该问题；修复属于压缩。
- **策展者**——由上下文地图提供策展者；未挂载时，树的行为与以前相同。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

设计文档位于 context-grants 波次的编排存储中。本包为实验性，不提供稳定性承诺。它不调用模型：分组和摘要来自文件文本、注册提示和工具描述。

</details>
