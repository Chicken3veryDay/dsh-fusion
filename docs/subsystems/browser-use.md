# Browser use

English | [中文](browser-use.zh.md)

Browser use lets an Agent inspect and operate web pages through a DSH-owned interaction capability. DSH owns the task loop, normalized `browser_*` tools, and exact-Agent lifecycle; a configured provider supplies the browser operations and keeps browser state across turns of one live Session.

The Web and Desktop compositions mount the interaction capability by default. On Linux, Playwright MCP supplies browser navigation, observation, tab, and screenshot operations. A Host without a ready provider admits no browser tool schemas, so the model does not receive unusable tools.

## Choose a provider

Mount [`dsh-browser-use`](../../packages/browser-use/browser-use/README.md) and one provider in the same composition. The providers are experimental public npm packages and require explicit activation. Their initial browser engine is Chromium.

| Provider | Integration |
|---|---|
| [Playwright MCP](../../packages/experimental/browser-use-playwright-mcp/README.md) | Playwright's browser-control MCP tools |
| [Chrome DevTools MCP](../../packages/experimental/browser-use-chrome-devtools-mcp/README.md) | Chrome DevTools inspection and control through MCP |
| [Stagehand](../../packages/experimental/browser-use-stagehand-native/README.md) | Native browser operations with AI-assisted actions, observation, and extraction |

The compatibility service registers provider names and rejects a second provider. The DSH interaction service adds the common Agent-facing operations and maps them to the selected provider; provider-specific MCP tools remain available for compatibility. Provider configuration selects launch or attachment for that activation.

## Session ownership

A launched browser belongs to the exact live Agent and Session that uses it. Calls across turns reuse that browser. Disposing the Session runtime closes its launched resources; reloading or forking a Session starts fresh browser state. Browser profiles and login state are not restored from the Session log.

An attached browser remains externally owned. The provider reserves it for one Session within that provider instance, preserves its existing browser state, and rejects simultaneous attachment by another Session. Teardown disconnects and leaves the external browser running. Separate DSH processes and other clients remain outside this reservation.

Provider shutdown stops tool admission and waits for owned work and resource cleanup before releasing the shared provider registration. Cancellation cannot undo a browser action already delivered.

## MCP initialization

An MCP provider initializes one client for each live Agent created after the provider loads. The existing serial `agent/created` event awaits connection and discovery before creation or resume completes and queued input runs. The client remains with the Session across turns. Startup failure or cancellation rejects creation or resume and triggers client cleanup.

If an attachment is busy, that activation continues without the browser and does not retry on later turns. After release, a newly created or resumed activation can acquire it. Loading or reloading the provider does not adopt already active Sessions; the [shared runtime](../../packages/experimental/browser-use-runtime/README.md) owns these initialization rules.

## Tools and recorded results

Normalized and compatibility tools use the normal DSH execution pipeline and Session log. Normalized results retain provider metadata while DSH owns the stable operation names and guidance. Stagehand's AI-assisted operations use its explicitly configured native model while DSH retains the task loop. Screenshots and live browser state remain provider-owned; replay does not reopen a browser.

Browser MCP connections also expose [resources and server instructions](mcp.md). Resource calls addressed to a browser server use its Session queue and reject other Sessions; server instructions are assembled only for its owning Session.

The [decision record](../../.agents/notes/implemented/architecture/2026-09-12-browser-use-provider-registration.md) explains the registration-only service and per-Session ownership.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Agent](core.md)

Source: [`packages/interaction/interaction/src/index.ts`](../../packages/interaction/interaction/src/index.ts)
<!-- END GENERATED cordis-surface -->
