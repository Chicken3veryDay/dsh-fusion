/** Session-owned MCP browser processes and provider catalog activation. @module */

import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Schema from '@deepseek-ai/schemastery'
import type { ImageMediaType, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { BrowserUseProviderName } from '@deepseek-ai/dsh-browser-use/brand'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { InteractionOperation } from '@deepseek-ai/dsh-interaction'
import { interactionProviderId } from '@deepseek-ai/dsh-interaction'
import { playwrightOperations, type BrowserMcpOperations } from './mcp-operations.ts'
import { type JsonValue } from '@deepseek-ai/dsh-util-values'
import { SessionResources } from './index.ts'
import type {} from '@deepseek-ai/dsh-browser-use'
import type {} from '@deepseek-ai/dsh-attachment'
import type { RegisteredTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-working-directory'

export { chromeDevtoolsOperations, playwrightOperations, type BrowserMcpCall, type BrowserMcpMethod, type BrowserMcpOperations } from './mcp-operations.ts'

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
  /** How this server's tool catalog executes normalized browser operations; omission uses the Playwright mapping. */
  operations?: BrowserMcpOperations
}

/** One Session's browser connection: the registration scope and the MCP server's own registrations. */
interface BrowserSession {
  scope: Scope
  server: McpClient.McpServerTools
}

interface ClientState {
  status: 'ready' | 'blocked'
  mask?: Scope
}

/** Replace provider image bytes with durable attachment references before a normalized result is logged.
 * @param ctx - context that owns the attachment store.
 * @param result - detached provider result containing MCP-style content blocks.
 * @param toolName - provider tool name used in diagnostics.
 * @returns the result with image blocks replaced by attachment references.
 */
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

/**
 * Resolve a raw operation to one of this Session's own MCP registrations. Only the connection's
 * current generation qualifies, so a same-named tool of another provider or scope never does.
 */
function providerTool(server: McpClient.McpServerTools, rawNames: readonly string[]): RegisteredTool {
  const tools = server.current()
  const registration = rawNames.map(raw => tools.get(raw)).find(candidate => candidate !== undefined)
  if (registration === undefined) throw new Error(`browser provider does not expose ${rawNames.join(' or ')}`)
  return registration
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
  let resources!: SessionResources<BrowserSession>
  const operations = options.operations ?? playwrightOperations
  let interactionCallSequence = 0
  // Calls of an interaction operation that already holds its Session's serialized slot.
  const heldCalls = new Set<ToolCallId>()
  const heldCallPrefix = `interaction-${randomUUID()}-`
  const servers = new Map<Agent, McpClient.McpServerTools>()
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
        describe: () => {
          const live = [...servers.values()].map(server => operations.methods(raw => server.current().has(raw)))
          const methods = live.length === 0
            ? operations.methods(() => true)
            : live.reduce((all, next) => all.filter(method => next.includes(method)))
          return { id: interactionProviderId(options.name), domains: ['browser'], methods, availability: 'ready' }
        },
        async open(agent, signal) {
          const { scope, server } = await resources.get(agent, signal)
          return {
            async execute(operation: InteractionOperation, operationSignal: AbortSignal): Promise<JsonValue> {
              if (operation.domain !== 'browser') throw new Error('browser provider received a desktop operation')
              // Registrations resolve before the first call so unsupported targeting never mutates the browser.
              const calls = operations.plan(operation).map(call => ({ call, registration: providerTool(server, call.tools) }))
              return resources.run(agent, operationSignal, async (_session, combined) => {
                const settled: JsonValue[] = []
                for (const { call, registration } of calls) {
                  const callId = ToolCallId(`${heldCallPrefix}${++interactionCallSequence}`)
                  heldCalls.add(callId)
                  let result: JsonValue
                  try {
                    result = JSON.parse(JSON.stringify(await scope.ctx.tools.invoke({
                      registration, arguments: call.args(settled), signal: combined, agent, callId,
                    }))) as JsonValue
                  } finally {
                    heldCalls.delete(callId)
                  }
                  const failed = typeof result === 'object' && result !== null && !Array.isArray(result) && result.isError === true
                  if (failed || call === calls.at(-1)?.call) return result
                  settled.push(result)
                }
                /* v8 ignore next -- every plan has at least one call */
                throw new Error('browser operation planned no provider call')
              })
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
              if (!ctx.tools.definitions(agent).some(definition => definition === exec.definition)) return next()
              throw new Error(`${options.name}: browser tool belongs to another Session`)
            }
            return next()
          })
          const config = McpClient.Config({
            transport: 'stdio',
            serverName: options.name,
            command: options.command,
            args: options.args,
            ...options.env === undefined ? {} : { env: options.env },
            cwd: await workingDirectory.ensure(agent, signal),
            ...options.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: options.toolCallTimeoutMs },
            failOnStartupError: true,
            reconnect: { enabled: false },
          })
          let server: McpClient.McpServerTools | undefined
          await scope.ctx.plugin({
            name: McpClient.name,
            inject: McpClient.inject,
            async apply(inner: Context) { server = await McpClient.connect(inner, config) },
          })
          signal.throwIfAborted()
          /* v8 ignore next -- an activated connection plugin has assigned its registrations */
          if (server === undefined) throw new Error(`${options.name}: browser MCP connection activated without registrations`)
          servers.set(agent, server)
          return {
            value: { scope, server },
            close() {
              servers.delete(agent)
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
    if (heldCalls.has(exec.callId)) return next()
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
