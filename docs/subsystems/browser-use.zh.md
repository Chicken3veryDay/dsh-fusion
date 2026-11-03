# 浏览器操作

[English](browser-use.md) | 中文

浏览器操作让 Agent 通过 DSH 自有的交互能力检查与操作网页。DSH 负责任务循环、规范化的 `browser_*` 工具和精确 Agent 的生命周期；配置的提供方提供浏览器操作，并在一个实时 Session 的多个轮次之间保留浏览器状态。

Web 和 Desktop 组合默认挂载交互能力。在 Linux 上，Playwright MCP 提供浏览器导航、观察、标签页和截图操作。没有就绪提供方的 Host 不会接纳浏览器工具模式，因此模型不会收到不可用的工具。

## 选择提供方

在同一组合中挂载 [`dsh-browser-use`](../../packages/browser-use/browser-use/README.zh.md) 和一个提供方。这些提供方是实验性公共 npm 包，需要显式激活。它们最初支持的浏览器引擎是 Chromium。

| 提供方 | 集成方式 |
|---|---|
| [Playwright MCP](../../packages/experimental/browser-use-playwright-mcp/README.zh.md) | Playwright 的浏览器控制 MCP 工具 |
| [Chrome DevTools MCP](../../packages/experimental/browser-use-chrome-devtools-mcp/README.zh.md) | 通过 MCP 进行 Chrome DevTools 检查与控制 |
| [Stagehand](../../packages/experimental/browser-use-stagehand-native/README.zh.md) | 原生浏览器操作，支持 AI（人工智能）辅助的动作、观测与提取 |

兼容服务注册提供方名称，并拒绝第二个提供方。DSH 交互服务增加 Agent 面向的通用操作，并将其映射到选定提供方；提供方专用的 MCP 工具在兼容模式下仍可用。Profile 中的提供方配置为此次激活选择启动或附加模式。

## Session 所有权

启动的浏览器属于使用它的确切实时 Agent 与 Session。跨轮次的调用复用该浏览器。Session 运行时释放时关闭其启动的资源；重新加载或 fork Session 时创建全新浏览器状态。浏览器 profile 和登录状态不会从 Session 日志恢复。

附加的浏览器仍归外部所有。提供方在该提供方实例内将浏览器保留给一个 Session，保留现有浏览器状态，并拒绝另一个 Session 同时附加。清理会断开连接并保持外部浏览器运行。独立 DSH 进程与其他客户端不受此保留约束。

提供方关闭时先停止接收工具调用，并等待自有工作与资源清理完成，再释放共享提供方注册。取消无法撤销已交付的浏览器操作。

## MCP 初始化

MCP 提供方为其加载后创建的每个活动 Agent 初始化一个客户端。现有的串行 `agent/created` 事件等待连接和发现结束后，创建或恢复才完成，排队输入才开始运行。客户端跨轮次归 Session 所有。启动失败或取消会拒绝创建或恢复，并触发客户端清理。

如果附加连接已被占用，本次激活不使用浏览器，但继续运行，后续轮次不会重试。连接释放后，新创建或恢复的激活可以获取它。加载或重新加载提供方不会接管已经活动的 Session；[共享运行时](../../packages/experimental/browser-use-runtime/README.zh.md)拥有这些初始化规则。

## 工具与记录结果

规范化工具和兼容工具使用常规 DSH 执行管线与 Session 日志。规范化结果保留提供方元数据，而 DSH 负责稳定的操作名称和指引。Stagehand 的 AI 辅助操作使用其显式配置的原生模型，DSH 保留任务循环。截图和活动浏览器状态仍由提供方负责；重放不会重新打开浏览器。

浏览器 MCP 连接还提供[资源和服务器指令](mcp.zh.md)。发往浏览器服务器的资源调用使用其 Session 队列，并拒绝其他 Session 的请求；服务器指令只会组装到所属 Session 的提示词中。

[决策记录](../../.agents/notes/implemented/architecture/2026-09-12-browser-use-provider-registration.zh.md)解释只注册名称的服务与按 Session 管理的所有权。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxbrowseruse--browseruseregistry"></a>

### `ctx.browserUse` — `BrowserUseRegistry`

Owns one optional provider registration in the shared browser-use service.

```ts cordis-catalog
/**
 * Reserve the sole provider slot until the contribution is disposed.
 * A second registration fails even when it repeats the current name. Providers
 * must stop their tools and await owned work before releasing this registration.
 * @param name - provider-owned name used in registration diagnostics.
 * @returns the effect disposer for this exact registration.
 */
register(name: BrowserUseProviderName): () => Promise<void>
```

Source: [`packages/browser-use/browser-use/src/index.ts`](../../packages/browser-use/browser-use/src/index.ts)

<a id="ctxinteraction--interactionservice"></a>

### `ctx.interaction` — `InteractionService`

Owns one provider per interaction domain and exact-Agent live resources.

```ts cordis-catalog
/**
 * Return the active provider description for one domain, if registered.
 * @param domain - interaction domain to inspect.
 * @returns provider metadata, or undefined when no provider is registered.
 */
describe(domain: InteractionDomain): InteractionProviderDescription | undefined

/**
 * Whether an exact live Agent can use a domain in the current step.
 * @param agent - live Agent requesting the capability.
 * @param domain - interaction domain to check.
 * @param method - optional normalized operation method to check.
 * @returns true when a ready provider supports the method for this Agent.
 */
available(agent: Agent, domain: InteractionDomain, method?: string): boolean

/**
 * Register one provider for a domain until its disposer completes.
 * @param provider - provider adapter owned by the registering plugin.
 * @returns disposer for this exact provider registration.
 */
register(provider: InteractionProvider): () => Promise<void>

/**
 * Run one operation through the exact Agent's serialized provider session.
 * @param agent - live Agent that owns the operation.
 * @param domain - operation domain.
 * @param operation - normalized operation.
 * @param signal - caller cancellation.
 * @returns detached provider result.
 */
async run(agent: Agent, domain: InteractionDomain, operation: InteractionOperation, signal: AbortSignal): Promise<JsonValue>
```

Types: [Agent](core.zh.md)

Source: [`packages/interaction/interaction/src/index.ts`](../../packages/interaction/interaction/src/index.ts)
<!-- END GENERATED cordis-surface -->
