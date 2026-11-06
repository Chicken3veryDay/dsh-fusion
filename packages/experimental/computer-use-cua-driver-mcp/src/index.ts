/**
 * Exclusive computer use through an installed Cua Driver MCP executable.
 * The MCP client owns discovery, execution, image admission, and reconnection.
 * @module
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use/brand'
import type { InteractionOperation } from '@deepseek-ai/dsh-interaction'
import { interactionProviderId, isDesktopActionKind } from '@deepseek-ai/dsh-interaction'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { type JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-computer-use'
import type { RegisteredTool } from '@deepseek-ai/dsh-tools'

/** Cordis plugin identity for the installed Cua Driver provider. */
export const name = 'experimental-computer-use-cua-driver-mcp'

/** MCP server namespace of this provider; its tools register as `mcp__cua-driver-mcp__<raw name>`. */
const SERVER_NAME = 'cua-driver-mcp'

/** The shared reservation and tool registry must exist before connection. */
export const inject = ['computerUse', 'tools']

/** Installed executable and MCP connection overrides. */
export interface Config {
  /** Executable path or PATH command; defaults to `cua-driver`. */
  command: string
  /** Arguments passed without a shell; defaults to `['mcp']`. */
  args: string[]
  /** Per-call timeout in milliseconds; omission uses the MCP client's default. */
  toolCallTimeoutMs?: number
  /** Reconnection overrides; defaults to the MCP client's policy. */
  reconnect: McpClient.ReconnectConfig
}

/** Validate executable options; the MCP client resolves connection defaults. */
export const Config: z<Partial<Config>, Config> = z.object({
  command: z.string().pattern(/[^\s]/u).default('cua-driver'),
  args: z.array(String).default(['mcp']),
  toolCallTimeoutMs: z.number().min(1),
  reconnect: z.object({
    enabled: z.boolean(),
    initialDelayMs: z.number().min(1),
    maxDelayMs: z.number().min(1),
    maxAttempts: z.number().min(1).step(1),
  }),
})

/**
 * Map a desktop operation to one of this provider's own MCP registrations. Only the connection's
 * current generation qualifies, so a same-named tool of another provider or scope never does.
 */
function desktopTool(
  server: McpClient.McpServerTools,
  operation: InteractionOperation,
): { registration: RegisteredTool; args: Record<string, JsonValue> } {
  if (operation.domain !== 'desktop') throw new Error('Cua Driver MCP provider received a browser operation')
  const tools = server.current()
  const find = (rawNames: readonly string[]): RegisteredTool => {
    const registration = rawNames.map(raw => tools.get(raw)).find(candidate => candidate !== undefined)
    if (registration === undefined) throw new Error(`Cua Driver MCP does not expose ${rawNames.join(' or ')}`)
    return registration
  }
  const target = {
    ...operation.applicationId === undefined ? {} : { application_id: operation.applicationId },
    ...operation.windowId === undefined ? {} : { window_id: operation.windowId },
  }
  if (operation.method === 'observe' || operation.method === 'screenshot') {
    return {
      registration: find(operation.method === 'screenshot' ? ['screenshot', 'get_window_state', 'get_desktop_state'] : ['get_window_state', 'get_desktop_state']),
      args: { ...target, ...operation.method === 'screenshot' ? { include_screenshot: true } : {} },
    }
  }
  if (typeof operation.action !== 'object' || operation.action === null || Array.isArray(operation.action)) throw new Error('desktop_act action must be an object with kind')
  const kind = operation.action.kind
  if (typeof kind !== 'string' || kind.length === 0) throw new Error('desktop_act action.kind must be a non-empty string')
  if (!isDesktopActionKind(kind)) throw new Error(`desktop_act action.kind "${kind}" is not supported by the normalized facade`)
  const { kind: _kind, ...args } = operation.action
  return { registration: find([kind, `desktop_${kind}`]), args: { ...target, ...args } }
}

/**
 * Reserve computer use and activate the installed Cua Driver's MCP tools.
 * Initial connection or discovery failure rejects activation and rolls back.
 * Disposal retains the reservation until the MCP child has finished teardown.
 * @param ctx - context providing computer use and the tool registry.
 * @param config - validated executable options and optional connection overrides.
 * @returns initial MCP tool-discovery completion.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  let interactionCallSequence = 0
  const connection = McpClient.Config({
    command: config.command,
    args: config.args,
    ...config.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: config.toolCallTimeoutMs },
    reconnect: config.reconnect,
    transport: 'stdio',
    serverName: SERVER_NAME,
    failOnStartupError: true,
  })
  // One effect orders child shutdown before release; separate fiber effects
  // unload concurrently and could otherwise admit another live driver.
  let child!: Fiber
  let server: McpClient.McpServerTools | undefined
  ctx.effect(function* () {
    yield ctx.computerUse.register(ComputerUseProviderName('cua-driver-mcp'))
    child = ctx.plugin({
      name: McpClient.name,
      inject: McpClient.inject,
      async apply(inner: Context) { server = await McpClient.connect(inner, connection) },
    })
    const interaction = ctx.get('interaction')
    if (interaction !== undefined) {
      yield interaction.register({
        domain: 'desktop',
        describe: () => ({ id: interactionProviderId('cua-driver-mcp'), domains: ['desktop'], methods: ['observe', 'act', 'screenshot'], availability: 'ready' }),
        open(agent: Agent, _signal: AbortSignal) {
          return Promise.resolve({
            execute: async (operation: InteractionOperation, signal: AbortSignal) => {
              if (server === undefined) throw new Error('Cua Driver MCP is not connected')
              const { registration, args } = desktopTool(server, operation)
              const result = await ctx.tools.invoke({
                registration, arguments: args, signal, agent, callId: ToolCallId(`interaction-${++interactionCallSequence}`),
              })
              return JSON.parse(JSON.stringify(result)) as JsonValue
            },
            close: async () => {},
          })
        },
      })
    }
    yield child.dispose
  }, 'computer-use-cua-driver-mcp.connection')
  await child.await()
}
