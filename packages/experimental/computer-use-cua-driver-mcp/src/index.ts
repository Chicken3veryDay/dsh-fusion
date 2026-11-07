/**
 * Exclusive computer use through an installed Cua Driver MCP executable.
 * The MCP client owns discovery, execution, image admission, and reconnection.
 * @module
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use/brand'
import type { DesktopCatalog, InteractionOperation } from '@deepseek-ai/dsh-interaction'
import { desktopActionKinds, desktopMethods, interactionProviderId, planDesktopOperation } from '@deepseek-ai/dsh-interaction'
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

/** The live catalog of this connection's current generation, read from its registrations' declared inputs. */
function desktopCatalog(server: McpClient.McpServerTools): DesktopCatalog {
  return { schema: tool => server.current().get(tool)?.definition.parameters }
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
        describe: () => {
          const catalog = server === undefined ? undefined : desktopCatalog(server)
          return {
            id: interactionProviderId('cua-driver-mcp'),
            domains: ['desktop'],
            methods: catalog === undefined ? [] : desktopMethods(catalog),
            actionKinds: catalog === undefined ? [] : desktopActionKinds(catalog),
            availability: 'ready',
          }
        },
        open(agent: Agent, _signal: AbortSignal) {
          return Promise.resolve({
            execute: async (operation: InteractionOperation, signal: AbortSignal) => {
              if (server === undefined) throw new Error('Cua Driver MCP is not connected')
              if (operation.domain !== 'desktop') throw new Error('Cua Driver MCP provider received a browser operation')
              const planned = planDesktopOperation(desktopCatalog(server), operation)
              // The plan read this tool's schema from the same registration map in this synchronous turn.
              const registration = server.current().get(planned.tool) as RegisteredTool
              const result = await ctx.tools.invoke({
                registration, arguments: planned.args, signal, agent, callId: ToolCallId(`interaction-${++interactionCallSequence}`),
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
