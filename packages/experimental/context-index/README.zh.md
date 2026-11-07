---
description: "把指令文件和文档确定性地拆分为可寻址的章节，并提供有界的章节读取和目录，面向构建按需上下文加载的开发者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-context-index

[English](README.md) | 中文

## 概述

上下文索引把用户全局和项目的指令文件，以及工作目录文档根目录下的 Markdown，拆分为章节。每个章节都有稳定的 id、内容哈希、字节大小，以及路径和标题锚点。服务注册 `ctx.contextIndex`，提供 `snapshot`（仅元数据）、`read`（有界正文）、`renderCatalog`（有界清单），以及 `latest`、`refreshes` 和 `lastRead`，后三者报告之前的刷新和读取，不访问文件系统。它不调用模型，不注册工具，也无需配置。

## 目录

- [使用本包](#use-this-package)
- [实现原理](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 `ctx.fs` 提供者（例如 `@deepseek-ai/dsh-fs-local`）之后挂载 `@deepseek-ai/dsh-experimental-context-index`。每次调用都带一个范围 `{ workingDirectory }`，它必须是已存在目录的绝对路径。没有任何已发布的 profile 挂载本包。

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-experimental-context-index'

export async function listSections(ctx: Context, workingDirectory: string) {
  const snapshot = await ctx.contextIndex.snapshot({ workingDirectory })
  const catalog = ctx.contextIndex.renderCatalog(snapshot.sections, { maxBytes: 4096 })
  const ids = snapshot.sections.slice(0, 1).map(section => section.id)
  const read = await ctx.contextIndex.read({ workingDirectory }, ids, { maxBytes: 8192 })
  return { catalog, read }
}
```

### 来源

索引覆盖的文件与 [`@deepseek-ai/dsh-agent-instructions`](../../context/agent-instructions/README.zh.md) 相同，顺序也相同：

1. harness 主目录（`$DSH_HOME`）中的 `AGENTS.md`，然后是共享 agents 根目录（`$DSH_AGENTS_HOME`）中的。
2. 从项目根目录（最近的、含 `projectRootMarkers` 条目的祖先目录，否则为工作目录）到工作目录的每个目录：先是 `instructionFileCandidates`，再是 `localInstructionFileCandidates`。
3. 工作目录下每个 `docRoots` 目录中的 Markdown 文件（`docExtensions`，比较时不区分大小写），按名称排序，跳过名称以 `.` 开头的条目和 `node_modules`。

`order` 越大的来源越具体，在指令中优先。与 agent-instructions 一样，在两个用户全局文件之间、以及同一项目目录内，修剪后内容与较早文件相同的文件会被排除；这不会被报告。两次都能到达的文件只索引一次。

索引只通过 `ctx.fs` 读取：用该服务解析、stat、列目录和读取文件，从不使用主机路径。`dsh-agent-instructions` 导出了 `discoverBaselineInstructionFiles`，但该函数读取主机文件系统，所以本包在 `ctx.fs` 上重复了它的发现规则。测试会在嵌套的夹具上比较两者的顺序。

### 章节与 id

每个 ATX 标题（围栏代码之外的 `#` 到 `######`）开启一个章节，持续到下一个任意级别的标题；`headingPath` 保存其所属的各级标题。第一个标题之前的文本是 0 级章节，除非它是空白。超过 `maxSectionBytes` 的章节先在段落边界（围栏代码之外的空行）拆分，然后在行边界拆分，最后在字符边界拆分；各部分拼接后与原章节文本完全一致，并按 `part` / `partCount` 编号。

章节 id（`sec_` 加 16 位十六进制）由来源标识（类型和显示路径）、标题路径、该来源中此前有多少章节具有相同标题路径，以及部分编号推导而来。它不由内容推导，所以编辑章节不会改变其 id。重命名标题、移动文件或重排重复标题会改变 id。增长超过 `maxSectionBytes` 的章节保持其第 1 部分的 id。

章节（以及来源）的 `hash` 是其确切文本（来源则为字节）的 `sha256:` 摘要。当来源、哈希、顺序或诊断发生变化时，`snapshot().revision` 增加；刷新后无变化则返回同一个快照对象。

### 刷新

每次 `snapshot` 或 `read` 调用都会重新校验索引；没有任何后台任务。它重新发现文件，并把每个文件的文件系统版本和大小与缓存记录比较。自身版本未变化的文档目录不会被重新列出；保留的列表被复用，其中每个文档文件仍会执行 stat，因此编辑会立即被发现，而新增、重命名或删除条目会改变目录版本，只让该目录被重新列出。由于文件系统时间戳粒度较粗，与某次列出处于同一时间戳步长内新增的条目可能不改变目录版本，因此列表只在列出后 2 秒内，或在第二次列出确认版本已保持 2 秒之后，才会不经重新列出而被复用。未变化的文件不会再次读取。已变化的文件会被读取并计算哈希，哈希与缓存哈希相同时只更新版本。同一工作目录刷新期间到达的调用共享该次刷新，因此共享的刷新可能报告略早于后到调用开始时的状态。被取消的调用立即停止等待；当没有调用者时共享刷新才停止，被取消的刷新不会改变任何状态。释放服务会中止正在运行的刷新，用 `CONTEXT_INDEX_DISPOSED` 拒绝它们和之后的调用，并清空缓存。

`latest(scope)` 返回某工作目录最近一次刷新提交的快照及该次刷新的序号，`refreshes()` 返回所有目录中最新的序号；调用者记下 `refreshes()`，之后若发现 `latest` 的序号更大，即可复用那次刷新而不必再发起一次。`lastRead(scope)` 把每个章节映射到其最近一次 `read` 返回的文本的哈希，不区分读取者；离开索引的章节和被逐出的目录会被遗忘。

### 读取与清单

`read(scope, ids, { maxBytes })` 针对新的快照解析 id，通过 `ctx.fs` 重新读取每个需要的文件，并按请求顺序返回正文。`hash` 和 `totalBytes` 描述整个章节，当预算在章节中途耗尽时，`text` 在字符边界处截断。正文被截断后，其余 id 列在 `omitted` 中；索引中不存在的 id 列在 `missing` 中。正文取自调用时的文件，因此请把 `hash` 与你持有的哈希比较以发现变化。

`renderCatalog(sections, { maxBytes })` 返回一行标题、每个章节一行 `id 大小B 锚点`（拆分的章节另加 `[part n/m]`），并在有章节被省略时给出最后一行 `(N more sections not listed)`。上限覆盖完整文本。每行保持完整；清单在第一条放不下（连同最后的计数行）的行处停止，当标题和最后的计数行都放不下时文本为空。

### 诊断

索引无法使用的文件不会出现在 `sections` 中，而是以代码、显示路径和消息出现在 `diagnostics` 中：`unreadable`（stat 或读取失败）、`not-utf8`、`too-large`（超过 `maxSourceBytes`）、`limit-exceeded`（达到 `maxDocFiles`、`maxDocDepth` 或 `maxTotalSourceBytes`）和 `directory-unreadable`。不再可读的文件会从索引中消失，直到再次可读；索引不会提供其最后一次的有效内容。缺失的候选文件是正常情况，不会被报告。

### 配置

所有字段均可选，并在服务挂载时验证；无效值会抛出带 `CONTEXT_INDEX_INVALID_CONFIG` 的 `ContextIndexError`。超过 `maxReadBytes` 或 `maxCatalogBytes` 的单次调用预算会被降到该值；不是正的安全整数的预算会抛出 `CONTEXT_INDEX_INVALID_INPUT`。

| 字段 | 默认值 | 依据 |
| --- | --- | --- |
| `projectRootMarkers` | `['.git']` | agent-instructions 默认值 |
| `instructionFileCandidates` | `['AGENTS.md', 'CLAUDE.md']` | agent-instructions 默认值 |
| `localInstructionFileCandidates` | `['AGENTS.local.md', 'CLAUDE.local.md']` | agent-instructions 默认值 |
| `docRoots` | `['docs', 'doc']` | 约定的根目录；本仓库使用 `docs/` |
| `docExtensions` | `['.md', '.markdown']` | Markdown 扩展名 |
| `maxSourceBytes` | 1,048,576 | agent-instructions 的 `maxSourceBytes`；本仓库 `docs/` 中最大的文件为 472,780 字节 |
| `maxSectionBytes` | 8,192 | 覆盖本仓库 `docs/` 中 10,432 个章节的 p99（6,124 字节），以及其 AGENTS.md 章节中最大的一个（8,483 字节，拆为两部分） |
| `maxHeadingBytes` | 120 | `docs/` 中 10,164 个标题里最长的为 113 字节（p99.9：93） |
| `maxDocFiles` | 1,024 | 本仓库 `docs/` 有 601 个 Markdown 文件 |
| `maxDocDepth` | 8 | 本仓库 `docs/` 中最深的文件位于第 4 层 |
| `maxTotalSourceBytes` | 16,777,216 | 本仓库 `docs/` 中 8.4 MB Markdown 的两倍 |
| `maxReadBytes` | 65,536 | `dsh-base` 中每条链的 agent-instructions 预算 |
| `maxCatalogBytes` | 8,192 | 指令预算的八分之一；约 100 行清单 |
| `maxIndexedDirectories` | 16 | 保留的工作目录数；淘汰最久未使用的 |

最小值：`maxSectionBytes` 和 `maxHeadingBytes` 至少为 16，其他数字至少为 1。harness 主目录通过 `@deepseek-ai/dsh-home-paths` 从进程环境获得，与 agent-instructions 相同，此处无法设置。`projectRootMarkers`、`instructionFileCandidates` 和 `localInstructionFileCandidates` 的条目必须是普通名称；`docRoots` 的条目必须是相对的、以 `/` 分隔且不含 `.` 或 `..` 的路径；`docExtensions` 的条目形如 `.md`。

<a id="understand-the-implementation"></a>
## 实现原理

- [`src/types.ts`](src/types.ts) 保存可在浏览器使用的类型：带品牌的 id、章节和来源元数据、诊断、预算、结果和 `Config`。通过 `@deepseek-ai/dsh-experimental-context-index/types` 导入。
- [`src/text.ts`](src/text.ts) 拆分 Markdown 章节、拆分过大的章节，并在 UTF-8 字符边界截断文本。
- [`src/sources.ts`](src/sources.ts) 通过 `ctx.fs` 发现候选文件，在大小上限内读取，并构建记录。
- [`src/catalog.ts`](src/catalog.ts) 渲染有界清单。
- [`src/ids.ts`](src/ids.ts) 和 [`src/config.ts`](src/config.ts) 推导 id 和哈希，并验证配置。
- [`src/index.ts`](src/index.ts) 是服务本身：按目录的缓存、可感知调用者取消的共享刷新，以及释放。

缓存保存章节元数据和文件版本，但不保存章节文本；`read` 会重新读取文件。已提交的状态整体替换，所以读取者不会看到刷新到一半的索引。

<a id="model-experience"></a>
## 模型体验

None, as 本包不增加工具、提示词或消息；注入 `renderCatalog` 输出或 `read` 正文的后续包负责自己的模型输入，并且必须记录所注入的内容。

#### KV 缓存影响

本包不改变请求前缀，因此没有影响；清单和读取的字节上限只是让后续使用者可以做预算。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 目前没有任何使用者。使用者所注入内容的 Session 日志、持久的项目地图和面向模型的加载工具，属于后续的包。
- 每次调用都会对每个文档目录和候选文件执行 stat；只有未变化的目录列表会被复用。每个模型步骤都调用的使用者每次都要承担这一成本；本包没有最小刷新间隔。
- 若符号链接条目的目标改变类型（文件变为目录），而链接本身及其所在目录都未变化，保留列表中的类型会一直沿用，直到该目录发生变化。
- 只有 ATX 标题会拆分章节。Setext 标题（用 `===` 或 `---` 加下划线）和 HTML 标题保留在上方章节的文本中。
- 文档根目录相对于工作目录而不是项目根目录，索引只遍历 `ctx.fs` 的目录条目，忽略 `.gitignore`。
- 变得不可读的文件会从索引中移除，而不是保留其最后的内容，所以使用者会看到它的 id 消失。
- 重命名标题、移动文件或重排重复标题时，章节 id 会改变。保存 id 的使用者应同时保存哈希。

<a id="dev-note"></a>
### 开发备注

本包是实验性的，不承诺稳定性。索引是由人维护的文件的缓存；这些文件仍是权威来源。
