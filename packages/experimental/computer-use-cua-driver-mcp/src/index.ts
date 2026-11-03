/**
 * Exclusive computer use through an installed Cua Driver MCP executable.
 * The MCP client owns discovery, execution, image admission, and reconnection.
 * @module
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import { Buffer } from 'node:buffer'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageMediaType, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import z from '@deepseek-ai/schemastery'
import { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use/brand'
import type { InteractionOperation } from '@deepseek-ai/dsh-interaction'
import { interactionProviderId } from '@deepseek-ai/dsh-interaction'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { isJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-computer-use'
import type { ToolRunContext, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'

/** Cordis plugin identity for the installed Cua Driver provider. */
export const name = 'experimental-computer-use-cua-driver-mcp'

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

let interactionCallSequence = 0

function desktopTool(ctx: Context, agent: Agent, operation: InteractionOperation): { name: string; args: Record<string, JsonValue> } {
  if (operation.domain !== 'desktop') throw new Error('Cua Driver MCP provider received a browser operation')
  const names = ctx.tools.schemas(agent).map(tool => tool.name)
  const find = (suffixes: readonly string[]): string => {
    const name = names.find(candidate => suffixes.some(suffix => candidate.endsWith(`__${suffix}`)))
    if (name === undefined) throw new Error(`Cua Driver MCP does not expose ${suffixes.join(' or ')}`)
    return name
  }
  const target = {
    ...operation.applicationId === undefined ? {} : { application_id: operation.applicationId },
    ...operation.windowId === undefined ? {} : { window_id: operation.windowId },
  }
  if (operation.method === 'observe' || operation.method === 'screenshot') {
    return {
      name: find(operation.method === 'screenshot' ? ['screenshot', 'get_window_state', 'get_desktop_state'] : ['get_window_state', 'get_desktop_state']),
      args: { ...target, ...operation.method === 'screenshot' ? { include_screenshot: true } : {} },
    }
  }
  if (typeof operation.action !== 'object' || operation.action === null || Array.isArray(operation.action)) throw new Error('desktop_act action must be an object with kind')
  const kind = operation.action.kind
  if (typeof kind !== 'string' || kind.length === 0) throw new Error('desktop_act action.kind must be a non-empty string')
  const { kind: _kind, ...args } = operation.action
  return { name: find([kind, `desktop_${kind}`]), args: { ...target, ...args } }
}

async function executeInteractionTool(
  ctx: Context,
  agent: Agent,
  name: string,
  args: Record<string, JsonValue>,
  signal: AbortSignal,
): Promise<JsonValue> {
  const definition = ctx.tools.get(name, agent)
  if (definition === undefined) throw new Error(`Cua Driver MCP tool "${name}" is unavailable`)
  const execution: ToolRunContext = {
    callId: ToolCallId(`interaction-${++interactionCallSequence}`),
    rootCallId: ToolCallId(`interaction-${interactionCallSequence}`),
    name,
    arguments: args,
    agent,
    signal,
    token: Symbol() as ToolExecutionToken,
    deferContext: () => {},
    concludeTurn: () => {},
  }
  const result: unknown = await definition.execute(args, execution)
  if (!isJsonValue(result)) throw new Error(`Cua Driver MCP tool "${name}" returned a non-JSON result`)
  return projectImages(ctx, JSON.parse(JSON.stringify(result)) as JsonValue, name)
}

async function projectImages(ctx: Context, result: JsonValue, toolName: string): Promise<JsonValue> {
  if (typeof result !== 'object' || result === null || Array.isArray(result) || !Array.isArray(result.content)) return result
  const images: SaveImageAttachment[] = []
  const indexes: number[] = []
  for (const [index, block] of result.content.entries()) {
    if (typeof block !== 'object' || block === null || Array.isArray(block) || block.type !== 'image') continue
    if (typeof block.data !== 'string' || typeof block.mimeType !== 'string') throw new Error(`Cua Driver MCP tool "${toolName}" returned an invalid image block`)
    const bytes = Buffer.from(block.data, 'base64')
    if (bytes.length === 0 || bytes.toString('base64') !== block.data) throw new Error(`Cua Driver MCP tool "${toolName}" returned non-canonical image data`)
    images.push({ data: new Uint8Array(bytes), mediaType: block.mimeType as ImageMediaType })
    indexes.push(index)
  }
  if (images.length === 0) return result
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error(`Cua Driver MCP tool "${toolName}" returned images but no attachment store is configured`)
  const refs = await attachments.saveImages(images)
  const content = result.content.map((block, index) => {
    const offset = indexes.indexOf(index)
    if (offset === -1) return block
    const attachment = refs[offset]
    if (attachment === undefined) throw new Error(`Cua Driver MCP tool "${toolName}" image admission returned too few references`)
    return { type: 'image', attachment: { attachmentId: attachment.attachmentId, mediaType: attachment.mediaType, bytes: attachment.bytes, width: attachment.width, height: attachment.height } }
  })
  return { ...result, content }
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
  const connection = McpClient.Config({
    command: config.command,
    args: config.args,
    ...config.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: config.toolCallTimeoutMs },
    reconnect: config.reconnect,
    transport: 'stdio',
    serverName: 'cua-driver-mcp',
    failOnStartupError: true,
  })
  // One effect orders child shutdown before release; separate fiber effects
  // unload concurrently and could otherwise admit another live driver.
  let child!: Fiber
  ctx.effect(function* () {
    yield ctx.computerUse.register(ComputerUseProviderName('cua-driver-mcp'))
    child = ctx.plugin(McpClient, connection)
    yield child.dispose
  }, 'computer-use-cua-driver-mcp.connection')
  await child.await()
  const interaction = ctx.get('interaction')
  if (interaction !== undefined) {
    const release = interaction.register({
      domain: 'desktop',
      describe: () => ({ id: interactionProviderId('cua-driver-mcp'), domains: ['desktop'], methods: ['observe', 'act', 'screenshot'], availability: 'ready' }),
      open(agent: Agent, _signal: AbortSignal) {
        return Promise.resolve({
          execute: async (operation: InteractionOperation, signal: AbortSignal) => {
            const selected = desktopTool(ctx, agent, operation)
            return executeInteractionTool(ctx, agent, selected.name, selected.args, signal)
          },
          close: async () => {},
        })
      },
    })
    ctx.effect(() => async () => { await release() }, 'computer-use-cua-driver-mcp.interaction')
  }
}
