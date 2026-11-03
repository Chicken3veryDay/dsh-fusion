/** Session-owned MCP browser processes and provider catalog activation. @module */

import { Buffer } from 'node:buffer'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Schema from '@deepseek-ai/schemastery'
import type { ImageMediaType, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { BrowserUseProviderName } from '@deepseek-ai/dsh-browser-use/brand'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { InteractionOperation } from '@deepseek-ai/dsh-interaction'
import { interactionProviderId } from '@deepseek-ai/dsh-interaction'
import { isJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import { SessionResources } from './index.ts'
import type {} from '@deepseek-ai/dsh-browser-use'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-working-directory'

/** Browser launch settings shared by the MCP integrations. */
export interface BrowserMcpLaunchConfig {
  /** Launch a new isolated Chromium browser for each live Session. */
  mode: 'launch'
  /** Whether Chromium runs without a visible window; defaults to true. */
  headless: boolean
  /** Chromium executable; omission uses the upstream server's installation discovery. */
  executablePath?: string
  /** Per-call timeout override in milliseconds; omission uses the MCP client default. */
  toolCallTimeoutMs?: number
}

/** Attachment to an externally owned Chromium browser. */
export interface BrowserMcpAttachConfig {
  /** Exclusively attach one live Session to the configured browser. */
  mode: 'attach'
  /** HTTP(S) debugging URL or WS(S) browser debugging endpoint. */
  endpoint: string
  /** Per-call timeout override in milliseconds; omission uses the MCP client default. */
  toolCallTimeoutMs?: number
}

/** Fixed launch or attachment choice for one MCP browser provider. */
export type BrowserMcpConfig = BrowserMcpLaunchConfig | BrowserMcpAttachConfig

/** Validate the browser mode before the provider reserves browser use. */
export const BrowserMcpConfig: Schema<BrowserMcpAttachConfig | (Omit<BrowserMcpLaunchConfig, 'headless'> & { headless?: boolean }), BrowserMcpConfig> = Schema.union([
  Schema.object({
    mode: Schema.const('launch').required(),
    headless: Schema.boolean().default(true),
    executablePath: Schema.string().pattern(/\S/u),
    toolCallTimeoutMs: Schema.number().min(1),
  }),
  Schema.object({
    mode: Schema.const('attach').required(),
    endpoint: Schema.string().pattern(/^https?:\/\/[^\s/]+|^wss?:\/\/[^\s/]+/u).required(),
    toolCallTimeoutMs: Schema.number().min(1),
  }),
])

/**
 * Reject an invalid debugging endpoint before acquiring provider or browser resources.
 * @param config - schema-validated browser selection.
 */
export function validateBrowserMcpConfig(config: BrowserMcpConfig): void {
  if (config.mode !== 'attach') return
  let endpoint: URL
  try {
    endpoint = new URL(config.endpoint)
  } catch (error) {
    throw new Error('browser endpoint must be a valid HTTP(S) or WS(S) URL', { cause: error })
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(endpoint.protocol) || /\s/u.test(config.endpoint)) {
    throw new Error('browser endpoint must be a valid HTTP(S) or WS(S) URL without whitespace')
  }
}

/** Provider-owned connection options for one live Session. */
export interface SessionMcpOptions {
  /** Provider identity and MCP tool namespace. */
  name: string
  /** Whether another live Session must wait for the attached browser to be released. */
  exclusive: boolean
  /** Executable used to start the installed MCP server. */
  command: string
  /** Arguments passed directly without a shell. */
  args: string[]
  /** Explicit overrides merged into the MCP client's scrubbed child environment. */
  env?: Record<string, string>
  /** Per-call timeout override; omission retains the MCP client default. */
  toolCallTimeoutMs?: number
}

interface ClientState {
  status: 'ready' | 'blocked'
  mask?: Scope
}

let interactionCallSequence = 0

async function executeScopedTool(
  scope: Scope,
  agent: Agent,
  name: string,
  args: Record<string, JsonValue>,
  signal: AbortSignal,
): Promise<JsonValue> {
  const definition = scope.ctx.tools.get(name, agent)
  if (definition === undefined) throw new Error(`browser provider tool "${name}" is unavailable`)
  const token = Symbol() as ToolExecutionToken
  const execution: ToolRunContext = {
    callId: ToolCallId(`interaction-${++interactionCallSequence}`),
    rootCallId: ToolCallId(`interaction-${interactionCallSequence}`),
    name,
    arguments: args,
    agent,
    signal,
    token,
    deferContext: () => {},
    concludeTurn: () => {},
  }
  const result: unknown = await definition.execute(args, execution)
  if (!isJsonValue(result)) throw new Error(`browser provider tool "${name}" returned a non-JSON result`)
  const detached = JSON.parse(JSON.stringify(result)) as JsonValue
  return projectProviderImages(scope.ctx, detached, name)
}

/** Replace MCP image bytes with durable attachment references before a normalized result is logged. */
export async function projectProviderImages(ctx: Context, result: JsonValue, toolName: string): Promise<JsonValue> {
  if (typeof result !== 'object' || result === null || Array.isArray(result) || !Array.isArray(result.content)) return result
  const images: SaveImageAttachment[] = []
  const indexes: number[] = []
  for (const [index, block] of result.content.entries()) {
    if (typeof block !== 'object' || block === null || Array.isArray(block) || block.type !== 'image') continue
    if (typeof block.data !== 'string' || typeof block.mimeType !== 'string') throw new Error(`browser provider tool "${toolName}" returned an invalid image block`)
    const bytes = Buffer.from(block.data, 'base64')
    if (bytes.length === 0 || bytes.toString('base64') !== block.data) throw new Error(`browser provider tool "${toolName}" returned non-canonical image data`)
    images.push({ data: new Uint8Array(bytes), mediaType: block.mimeType as ImageMediaType })
    indexes.push(index)
  }
  if (images.length === 0) return result
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error(`browser provider tool "${toolName}" returned images but no attachment store is configured`)
  const refs = await attachments.saveImages(images)
  const content = result.content.map((block, index) => {
    const offset = indexes.indexOf(index)
    if (offset === -1) return block
    const attachment = refs[offset]
    if (attachment === undefined) throw new Error(`browser provider tool "${toolName}" image admission returned too few references`)
    return {
      type: 'image',
      attachment: {
        attachmentId: attachment.attachmentId,
        mediaType: attachment.mediaType,
        bytes: attachment.bytes,
        width: attachment.width,
        height: attachment.height,
        ...attachment.name === undefined ? {} : { name: attachment.name },
        ...attachment.originalDimensions === undefined ? {} : { originalDimensions: attachment.originalDimensions },
      },
    }
  })
  return { ...result, content }
}

function providerTool(scope: Scope, agent: Agent, suffixes: readonly string[]): string {
  const names = scope.ctx.tools.schemas(agent).map(tool => tool.name)
  const name = names.find(candidate => suffixes.some(suffix => candidate.endsWith(`__${suffix}`)))
  if (name === undefined) throw new Error(`browser provider does not expose ${suffixes.join(' or ')}`)
  return name
}

function browserOperation(scope: Scope, agent: Agent, operation: InteractionOperation): { name: string; args: Record<string, JsonValue> } {
  if (operation.domain !== 'browser') throw new Error('browser provider received a desktop operation')
  if (operation.method === 'navigate') return { name: providerTool(scope, agent, ['browser_navigate']), args: { url: operation.url } }
  if (operation.method === 'observe') {
    return {
      name: providerTool(scope, agent, ['browser_snapshot', 'browser_observe']),
      args: operation.instruction === undefined ? {} : { target: operation.instruction },
    }
  }
  if (operation.method === 'screenshot') return { name: providerTool(scope, agent, ['browser_take_screenshot', 'browser_screenshot']), args: {} }
  if (operation.method === 'tabs') {
    const index = operation.tabId === undefined ? undefined : Number(operation.tabId)
    if (index !== undefined && (!Number.isInteger(index) || index < 0)) {
      throw new Error('browser_tabs tabId must be a non-negative integer for this provider')
    }
    return {
      name: providerTool(scope, agent, ['browser_tabs', 'browser_tab_list']),
      args: {
        action: operation.operation,
        ...index === undefined ? {} : { index },
        ...operation.url === undefined ? {} : { url: operation.url },
      },
    }
  }
  if (operation.method === 'act') {
    if (typeof operation.action !== 'object' || operation.action === null || Array.isArray(operation.action)) {
      throw new Error('browser_act action must be an object with kind')
    }
    const kind = operation.action.kind
    if (typeof kind !== 'string' || kind.length === 0) throw new Error('browser_act action.kind must be a non-empty string')
    const { kind: _kind, ...args } = operation.action
    return { name: providerTool(scope, agent, [`browser_${kind}`, kind]), args }
  }
  throw new Error(`browser provider does not support normalized ${operation.method} yet`)
}

/**
 * Await one MCP client during each future Agent's creation.
 * A busy attachment leaves that activation without browser tools; its other turns continue.
 * Calls are serialized per Session; unload closes every server before releasing registration.
 * @param ctx - provider context supplying browser use, Agents, tools, prompt assembly, and working directories.
 * @param options - provider identity, attachment exclusivity, and executable configuration.
 * @throws when the working-directory provider is absent, before browser resources are registered.
 */
export function mountSessionMcp(ctx: Context, options: SessionMcpOptions): void {
  const workingDirectory = ctx.get('workingDirectory')
  if (workingDirectory === undefined) throw new Error(`${options.name}: browser MCP requires a working-directory provider`)
  let resources!: SessionResources<Scope>
  const clients = new Map<Agent, ClientState>()
  const toolPrefix = `mcp__${options.name}__`
  const resourceTools = new Set(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'])
  let stopping = false
  let refreshingMasks = false

  const refreshBlockedMasks = (): void => {
    if (stopping || refreshingMasks) return
    refreshingMasks = true
    try {
      for (const [agent, state] of clients) {
        if (state.status !== 'blocked') continue
        const inherited = ctx.tools.schemas(agent).filter(tool => tool.name.startsWith(toolPrefix))
        if (inherited.length === 0) continue
        state.mask ??= createScope(ctx, agent)
        state.mask.ctx.tools.restrict({ deny: inherited.map(tool => tool.name) })
      }
    } finally {
      refreshingMasks = false
    }
  }

  ctx.effect(function* () {
    yield ctx.browserUse.register(BrowserUseProviderName(options.name))
    const interaction = ctx.get('interaction')
    if (interaction !== undefined) {
      yield interaction.register({
        domain: 'browser',
        describe: () => ({ id: interactionProviderId(options.name), domains: ['browser'], methods: ['navigate', 'tabs', 'observe', 'act', 'screenshot'], availability: 'ready' }),
        async open(agent, signal) {
          const scope = await resources.get(agent, signal)
          return {
            async execute(operation: InteractionOperation, operationSignal: AbortSignal): Promise<JsonValue> {
              const selected = browserOperation(scope, agent, operation)
              return executeScopedTool(scope, agent, selected.name, selected.args, operationSignal)
            },
            close: async () => {},
          }
        },
      })
    }
    resources = new SessionResources(ctx, {
      label: options.name,
      exclusive: options.exclusive,
      async open(agent, signal) {
        const scope = createScope(ctx, agent)
        let cancellation: Promise<void> | undefined
        const cancel = (): void => { cancellation = scope.dispose() }
        signal.addEventListener('abort', cancel, { once: true })
        try {
          signal.throwIfAborted()
          scope.ctx.on('tools/execute', async (exec, next) => {
            if (!exec.name.startsWith(toolPrefix)) return next()
            if (exec.agent !== agent) {
              if (ctx.tools.get(exec.name, exec.agent) !== ctx.tools.get(exec.name, agent)) return next()
              throw new Error(`${options.name}: browser tool belongs to another Session`)
            }
            return next()
          })
          await scope.ctx.plugin(McpClient, McpClient.Config({
            transport: 'stdio',
            serverName: options.name,
            command: options.command,
            args: options.args,
            ...options.env === undefined ? {} : { env: options.env },
            cwd: await workingDirectory.ensure(agent, signal),
            ...options.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: options.toolCallTimeoutMs },
            failOnStartupError: true,
            reconnect: { enabled: false },
          }))
          signal.throwIfAborted()
          return {
            value: scope,
            close() {
              clients.delete(agent)
              return scope.dispose()
            },
          }
        } catch (error) {
          await (cancellation ?? scope.dispose())
          throw error
        } finally {
          signal.removeEventListener('abort', cancel)
        }
      },
    })
    yield async () => {
      stopping = true
      await resources.dispose()
      clients.clear()
    }
  }, `${options.name}.sessions`)
  ctx.on('agent/created', async ({ agent, signal }) => {
    const state: ClientState = { status: resources.available(agent) ? 'ready' : 'blocked' }
    agent.ctx.effect(() => async () => {
      clients.delete(agent)
      await state.mask?.dispose()
    }, `${options.name}.activation`)
    if (state.status === 'blocked') {
      clients.set(agent, state)
      refreshBlockedMasks()
      return
    }
    await resources.get(agent, signal)
    clients.set(agent, state)
  }, { prepend: true })
  ctx.on('tools/change', refreshBlockedMasks)
  ctx.on('tools/execute', async (exec, next) => {
    const ownResource = resourceTools.has(exec.name)
      && typeof exec.arguments === 'object' && exec.arguments !== null
      && (exec.arguments as { server?: unknown }).server === options.name
    if (!exec.name.startsWith(toolPrefix) && !ownResource) return next()
    const agent = exec.agent
    if (agent === undefined || clients.get(agent)?.status !== 'ready') {
      throw new Error(`${options.name}: browser tool belongs to another Session`)
    }
    return resources.run(agent, exec.signal, async (_scope, combined) => {
      const original = exec.signal
      exec.signal = combined
      try {
        return await next()
      } finally {
        exec.signal = original
      }
    })
  })
  ctx.on('system-prompt/assemble', async (_assembly, { agent }, next) => {
    const assembly = await next()
    if (agent === undefined || clients.get(agent)?.status === 'ready') return assembly
    return { ...assembly, sections: assembly.sections.filter(section => section.name !== `mcp:${options.name}`) }
  })
}
