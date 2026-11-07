---
description: "使用并排查实验性 Web Workstream 面板，处理问题并查看工单、成员、变更请求与证据文件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-workstream

[English](README.md) | 中文

## 概述

本包向 Web 会话页头添加 Workstream action。面板包含五个视图：待你处理、工作、成员、变更与文件。它从共享 Session store 读取 Workstream 根 Session 的 `workstream`、`ticket` 与 `workstreamEvidence` 投影，因此面板随 Host 投影 frame 更新。待你处理视图通过以当前显示 Session 身份执行的 Host Remote 回答和关闭工单问题，并确认和解决关注事项。变更视图读取 Workstream 成员绑定的变更请求。通过实验性 Workstream profile 层选择本包。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

通过 [`@deepseek-ai/dsh-experimental-workstream-profile`](../workstream-profile/README.zh.md) 启用本包。该层同时提供 Ticket、Workstream 与 Workstream Evidence 服务以及本面板。Web Client loader 挂载 `/client` export，Host 将 root export 加载为 `workstreamPanel` Remote。本包没有用户配置字段。

页头 action 只出现在 Workstream 根投影了 Workstream 的会话中：所有者 Session，或作为所有者 continuable 子会话打开的成员。徽标显示待你处理中的事项数。点击 action 打开面板；点击外部或按 Escape 关闭；用于取消输入法组合的 Escape 不会关闭。页头较窄时 action 只显示图标和徽标；手机宽度的面板会隐藏标签页上的各视图数量。

### 处理问题与关注事项

待你处理按时间顺序列出尚未结束的工单中打开的问题和未解决的关注事项。问题卡片包含回答输入框、发送回答与关闭问题。关注卡片在确认前提供确认，并始终提供解决。每条命令携带面板显示时的工单 revision。若其他更改先提交，面板会在报告冲突前强制重新读取根投影。重新读取失败时会报告错误，而不声称已显示当前状态。命令失败通过应用级 toast 显示，即使卡片、标签页、面板或会话已关闭；一条命令只会清除它自己先前的报告，命令由工作流根、工单以及问题或关注事项标识。回答文本按工单和问题保存在插件拥有的状态中，而不在卡片里：切换标签页、点击外部、关闭面板和发送被拒绝后都会保留。当问题已无法回答（他人已回答或关闭，或其工单已结束）时，文本保留在待你处理顶部的保留行中，其中有问题、可选择的文本框、复制回答与丢弃。该行计入徽标；若问题再次可回答，文本会回到卡片。回答发送期间其草稿被锁定：该问题的每张卡片（包括切换标签页或会话后重新挂载的卡片）都会禁用输入框并拒绝再次发送。已提交的回答仅在发送之后没有新的编辑时才清除其草稿；更新的文本会保留。

工单服务决定谁可以执行操作。回答、确认和解决需要工单协调者，因此不协调该工单的成员会话会显示权限提示。问题作者也可以关闭自己的问题。Remote 命令还要求对当前显示的 Session 和推导出的根 Session 都有访问权限。

### 查看工作、成员、变更与文件

- **工作** 显示 Mission 计划及按工单状态计算的各里程碑完成数，然后列出每个工单的状态、协调者、依赖与分派。
- **成员** 显示每个成员的角色、协调者标记、阶段、描述，以及成员仍在准备中时的本地化提示。选择所有者会打开所有者 Session；选择其他成员会打开其 continuable 子会话地址。当前会话与准备中的成员不可选择。
- **变更** 在视图打开和点击重新加载时读取聚合的变更请求。重新加载期间及失败后保留上次成功读取的列表，并在旁边显示错误。每一项链接到其网页并列出绑定它的 Session。当某个 Session 或 forge 服务无法读取时，提示说明列表可能不完整并以类型化缺口生成的本地化文本给出原因。
- **文件** 显示每个证据产物及其每个保留版本的编号、大小、作者与摘要前缀。面板不读取产物内容。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

`WorkstreamPanelController` 是 `TypertRemoteService`，每个方法都有一个 Agent lookup 参数，因此 Gateway 解析当前显示的 Session，并按该 Session 资源进行访问检查。没有 wire 字段可以指定第二个 Session。控制器从调用者自身的 Session header 推导 Workstream 根，以实时调用者调用 `ctx.workstreams.requireMembership`，并以调用者为 actor 在根的工单日志上执行 `ctx.tickets.answer`、`closeQuestion`、`acknowledgeAttention` 或 `resolveAttention`，并以调用者作为发起 Agent。`changeRequests` 在读取 `ctx.workstreamEvidence.aggregateChangeRequests` 前检查根和每个保留成员（包括已停止成员）的访问权限；权限不足会拒绝整个读取。工单命令在读取成员资格或追加根日志前检查根访问权限。Ticket 与 Workstream 失败转换为 `workstreamPanel/stale-revision`、`workstreamPanel/denied`、`workstreamPanel/unavailable` 或 `workstreamPanel/rejected`。当调用者不是 Workstream 的活跃成员时，拒绝访问携带 `reason: 'not-member'`，无论来自提前的 `requireMembership` 检查，还是来自 Workstream 的 Ticket 命令授权方拒绝在命令于 Ticket 队列中等待期间被 `stop` 撤销成员资格的调用者；服务正在停止时，拒绝变更携带 `reason: 'workstream-stopping'`，其他 Workstream 拒绝携带 `reason: 'workstream'`，因此面板显示 Workstream 的原因，而不是 Ticket 的措辞。根或成员 Session 缺少 Remote 访问授权时为 `workstreamPanel/forbidden`。其他失败原样传播。

Client export 先挂载生成的 Remote，再注册 locale 字典、会话页头 action 和 shell overlay 命令报告；释放时先撤回两个 slot，再撤回 Remote。stale-revision 失败调用 `sessions.refreshProjections(root, true)`，绕过已就绪的缓存并取消较早的读取。带序号的基线保留较新的投影帧。被同一根的较新重新读取中止的读取，会等待较新的读取，而不报告刷新失败。Gateway 的 `remote-access/denied` 与 `workstreamPanel/forbidden` 都显示本地化的无权限文案。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | Host Remote 与失败映射 |
| [`src/types.ts`](src/types.ts) | 浏览器安全的 Remote 请求与失败码 |
| [`src/client/mount.ts`](src/client/mount.ts) | Remote、locale、导航与 slot 注册 |
| [`src/client/WorkstreamAction.tsx`](src/client/WorkstreamAction.tsx) | 页头 action、面板与视图选择 |
| [`src/client/views.tsx`](src/client/views.tsx) | 五个视图、其命令卡片与保留的回答 |
| [`src/client/drafts.ts`](src/client/drafts.ts) | 按根、工单和问题保存的回答草稿 |
| [`src/client/notices.tsx`](src/client/notices.tsx) | shell overlay 中的命令拒绝 toast |
| [`src/client/model.ts`](src/client/model.ts) | 从工单推导的待你处理事项与 Mission 进度 |
| [`src/client/locales.ts`](src/client/locales.ts) | 八种语言的面板文案 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Workstream profile 层](../workstream-profile/README.zh.md) — 挂载本面板的可选层。
- [Ticket 服务](../ticket/README.zh.md) — 工单状态、命令与权限规则。
- [Workstream 服务](../workstream/README.zh.md) — 成员关系与协调者交接。
- [Workstream Evidence](../workstream-evidence/README.zh.md) — 证据版本与变更请求聚合。
- [实验性包](../README.zh.md) — 孵化状态与发布策略。

-----

<a id="model-experience"></a>
## 模型体验

间接影响来自智能体使用 Ticket 工具读取的工单回答与关注事项变化；这些文本由 Ticket 服务负责。

#### KV Cache 影响

面板不追加模型输入。已提交的命令会改变工单状态，只有当智能体之后读取该工单时才会到达模型。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅协调者可回答** — 人类以当前显示的 Session 身份操作，因此回答需要打开工单协调者的会话，通常是所有者。
- **需要所有者在线** — 命令和变更视图需要所有者 Session 已加载；否则面板显示不可用提示。
- **不管理工单或成员** — 面板不能创建、分派、结束或交接工单，不能添加或停止成员，也不能发送 peer 消息。
- **文件仅含元数据** — 文件视图列出证据版本，但不打开或下载其内容。
- **草稿仅存于内存** — 未发送和保留的回答在面板关闭后仍在，但页面刷新后丢失。
- **按需读取变更请求** — 变更视图不跟随 forge 轮询；点击重新加载可再次读取。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
