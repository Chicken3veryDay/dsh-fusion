/** Standard ACP updates derived from committed DSH session events. */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionUpdate, ToolCallContent } from '@agentclientprotocol/sdk'
import { errorChain, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc/types'
import { assistantBlockToAcp } from './content.ts'

/** Text delivered in place of a result image the attachment store could not read. */
export const ACP_UNAVAILABLE_IMAGE_NOTICE = '[Image unavailable: the attachment could not be read.]'

/**
 * Convert one committed assistant message and its context usage in block order.
 * @param ctx - bridge context carrying attachment and token-meter services.
 * @param session - durable session used for context pressure.
 * @param event - committed assistant message event.
 * @returns ordered standard thought, message, and optional usage updates.
 */
export async function assistantUpdates(
  ctx: Context,
  session: Session,
  event: SessionEvent<'assistant/message'>,
): Promise<SessionUpdate[]> {
  const updates: SessionUpdate[] = []
  for (const block of event.data.message.content) {
    if (block.type === 'reasoning') {
      if (block.text.length > 0) {
        updates.push({
          sessionUpdate: 'agent_thought_chunk',
          messageId: event.data.message.id,
          content: { type: 'text', text: block.text },
        })
      }
      continue
    }
    const content = await assistantBlockToAcp(ctx, block)
    if (content !== undefined) {
      updates.push({
        sessionUpdate: 'agent_message_chunk',
        messageId: event.data.message.id,
        content,
      })
    }
  }
  const usage = usageUpdate(ctx, session, event)
  if (usage !== undefined) updates.push(usage)
  return updates
}

/**
 * Start one generic ACP tool lifecycle from the durable call fact.
 * @param event - committed DSH tool-call event.
 * @returns the standard generic tool-call update.
 */
export function toolCallUpdate(event: SessionEvent<'tool/call'>): SessionUpdate {
  return {
    sessionUpdate: 'tool_call',
    toolCallId: event.data.callId,
    title: event.data.name,
    kind: 'other',
    status: 'in_progress',
    rawInput: parseToolArguments(event.data.arguments),
  }
}

/**
 * Finish one generic ACP tool lifecycle from its committed model-facing result.
 * The update is always produced: an image that cannot be read is replaced by
 * {@link ACP_UNAVAILABLE_IMAGE_NOTICE}, and the status stays the tool's own outcome.
 * @param ctx - bridge context carrying the attachment store.
 * @param event - committed DSH tool-result event.
 * @returns the standard completed or failed tool-call update.
 */
export async function toolResultUpdate(
  ctx: Context,
  event: SessionEvent<'tool/result'>,
): Promise<SessionUpdate> {
  const message = event.data.message
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: message.toolCallId,
    status: message.isError === true ? 'failed' : 'completed',
    content: await toolContent(ctx, message.content),
  }
}

/**
 * `_meta` key naming the enclosing `run_code` tool call on a nested tool update.
 * ACP has no parent field, so a client groups a nested call under its program by this value.
 */
export const ACP_PARENT_TOOL_CALL_META = 'dsh/parentToolCallId'

/**
 * Start one nested tool lifecycle for a call made inside a `run_code` program.
 * @param event - committed nested dispatch start; it carries the JSON-normalized arguments.
 * @returns a generic tool-call update whose `_meta` names the enclosing program call.
 */
export function ptcDispatchStartUpdate(event: SessionEvent<'tool/ptc-dispatch-start'>): SessionUpdate {
  return {
    sessionUpdate: 'tool_call',
    toolCallId: event.data.subCallId,
    title: event.data.name,
    kind: 'other',
    status: 'in_progress',
    rawInput: event.data.arguments,
    _meta: { [ACP_PARENT_TOOL_CALL_META]: event.data.parentCallId },
  }
}

/**
 * Finish one nested tool lifecycle from its settled outcome. As for
 * {@link toolResultUpdate}, an unreadable image becomes a text notice, so every
 * started nested call receives this terminal update.
 * @param ctx - bridge context carrying the attachment store.
 * @param event - committed nested dispatch settlement, durable result content included.
 * @returns the completed or failed update, paired with the start by `subCallId`.
 */
export async function ptcDispatchUpdate(
  ctx: Context,
  event: SessionEvent<'tool/ptc-dispatch'>,
): Promise<SessionUpdate> {
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: event.data.subCallId,
    status: event.data.isError ? 'failed' : 'completed',
    content: await toolContent(ctx, event.data.content),
    _meta: { [ACP_PARENT_TOOL_CALL_META]: event.data.parentCallId },
  }
}

/**
 * Convert model-facing result blocks to ACP content, dropping blocks ACP cannot carry.
 * An image that cannot be delivered becomes a text notice, so the result keeps its other blocks and its lifecycle terminates.
 */
async function toolContent(ctx: Context, blocks: readonly ContentBlock[]): Promise<ToolCallContent[]> {
  const content: ToolCallContent[] = []
  for (const block of blocks) {
    let converted: Awaited<ReturnType<typeof assistantBlockToAcp>>
    try {
      converted = await assistantBlockToAcp(ctx, block)
    } catch (error: unknown) {
      // Conversion fails only as AcpContentError: no store is mounted, or the attachment cannot be read.
      ctx.logger.warn(`acp: tool-result image replaced by a notice: ${errorChain(error)}`)
      converted = { type: 'text', text: ACP_UNAVAILABLE_IMAGE_NOTICE }
    }
    if (converted !== undefined) content.push({ type: 'content' as const, content: converted })
  }
  return content
}

/** Report current context occupancy only when DSH has both usage and capacity facts. */
function usageUpdate(
  ctx: Context,
  session: Session,
  event: SessionEvent<'assistant/message'>,
): SessionUpdate | undefined {
  if (event.data.usage === undefined) return undefined
  const size = session.requestContext()?.contextWindow
  const meter = ctx.get('tokenMeter')
  if (size === undefined || meter === undefined) return undefined
  return {
    sessionUpdate: 'usage_update',
    used: meter.measure(session).totalTokens,
    size,
  }
}

/** Preserve malformed model output as opaque input instead of dropping the call update. */
function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch (_invalidModelJson) {
    return value
  }
}
