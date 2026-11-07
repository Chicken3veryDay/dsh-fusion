---
description: "在主题不是进程隔离的测试中，让本地 subprocess runtime 走进程组路径。"
kind: "package-library"
---

# @deepseek-ai/dsh-subprocess-testkit

[English](README.md) | 中文

## 概述

在通过 `LocalSubprocessRuntime` 运行大量真实命令（`git`、`rg`）、且测试主题不是进程隔离的测试中使用本包。Linux 上 runtime 会把每次 spawn 包进临时 systemd scope，tsx 缓存预热时每次约 95 ms，冷缓存时约 236 ms；本辅助函数让 runtime 改走 macOS 所用的、开销更低的进程组路径，命令仍作为真实进程运行。调用方负责 Cordis context、插件组合和资源清理。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将 `@deepseek-ai/dsh-subprocess-testkit` 加入消费包的 `devDependencies`。先挂载 `LocalSubprocessRuntime`，再在首次 spawn 之前调用该辅助函数：

```ts
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { useProcessGroupContainment } from '@deepseek-ai/dsh-subprocess-testkit'

const ctx = new Context()
await ctx.plugin(LocalSubprocessRuntime)
useProcessGroupContainment(ctx)
```

组合挂载的是其他 subprocess 提供者时，辅助函数会抛出错误。主题是进程隔离、信号发送、后台作业、终端或沙箱的测试，以及端到端和性能测试文件不要使用它：它们保留真实 scope。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

[`src/index.ts`](src/index.ts) 在 Linux 上把 runtime 的 `internals.platform` 测试钩子设为 `darwin`，这是 runtime 唯一的隔离方式选择接缝。该钩子同时影响进程组所有者：它跳过 Linux 的 `/proc` 组成员探测，仅根据对进程组发送信号 0 的结果判断存活，因此比直接子进程存活更久的后代通过进程组观察，而不是通过 Linux 成员扫描。已有的 `internals` 字段会保留。辅助函数不修改产品配置，在其他平台上不做任何事。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [本地 subprocess runtime](../../subprocess/subprocess-local/README.zh.md) — 隔离模式及其每次 spawn 的开销。
- [测试策略](../../../docs/testing.zh.md) — 为生产行为选择验证方式。
- [test-support 组地图](../README.zh.md) — 同组测试工具。

-----

<a id="model-experience"></a>
## 模型体验

无，因为这些测试辅助函数不组装也不发送模型请求。

#### KV Cache 影响

无；本包自身不发送提供者请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 使用该辅助函数的测试不再覆盖真实 scope；`subprocess-local` 保留 native-containment 测试。
- 辅助函数通过平台覆盖而非具名选项进入进程组路径；runtime 提供具名隔离选项后可替换它。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>
