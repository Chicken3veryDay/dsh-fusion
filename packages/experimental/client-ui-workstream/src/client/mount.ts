/** Remote contribution and header-action registration of the Workstream panel. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-experimental-client-ui-workstream/remote'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteErrorCode, RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { WorkstreamAction, type WorkstreamActionInjected, type WorkstreamCommand, type WorkstreamFailure } from './WorkstreamAction.tsx'
import { de, en, es, fr, ja, NS, pt, ru, zh, type WorkstreamKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Workstream panel copy. */
    workstream: WorkstreamKey
  }
}

/** Services required before the Remote contribution mounts. */
export const inject = ['remote', 'sessions', 'uiWorkspace', 'slots', 'locale']

/**
 * Classify a Remote failure for inline display.
 * @param error - typed Remote failure.
 * @returns the panel failure kind and Host diagnostic.
 */
export function failureOf(error: { readonly code: RemoteErrorCode; readonly message: string }): WorkstreamFailure {
  switch (error.code) {
    case 'workstreamPanel/stale-revision': return { code: 'stale', message: error.message }
    case 'workstreamPanel/denied': return { code: 'denied', message: error.message }
    case 'workstreamPanel/unavailable': return { code: 'unavailable', message: error.message }
    case 'workstreamPanel/rejected': return { code: 'rejected', message: error.message }
    default: return { code: 'failed', message: error.message }
  }
}

function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'client-ui-workstream: dictionaries')
  const { sessions } = ctx
  const rootOf = (sessionId: SessionId): SessionId =>
    sessions.binding(sessionId)?.session.getSnapshot().subagent?.address.parentSessionId ?? sessionId
  const send = (sessionId: SessionId, command: WorkstreamCommand): Promise<RemoteResult<void>> => {
    const panel = ctx.remote.workstreamPanel
    switch (command.kind) {
      case 'answer': return panel.answerQuestion(sessionId, command.request)
      case 'closeQuestion': return panel.closeQuestion(sessionId, command.request)
      case 'acknowledge': return panel.acknowledgeAttention(sessionId, command.request)
      case 'resolve': return panel.resolveAttention(sessionId, command.request)
    }
  }

  const actions: WorkstreamActionInjected = {
    openMember(sessionId, memberId) {
      if ((sessions.retainInfo(sessionId).getSnapshot().retainedBy.mainView ?? 0) === 0) return
      const parentSessionId = rootOf(sessionId)
      if (memberId === parentSessionId) {
        ctx.uiWorkspace.openSession(parentSessionId)
        return
      }
      ctx.uiWorkspace.openSession({ parentSessionId, childSessionId: memberId, mode: 'continuable' })
    },
    async command(sessionId, command) {
      const result = await send(sessionId, command)
      if (result.ok) return null
      const failure = failureOf(result.error)
      // The projection frame may lag the rejected command; reread so the next attempt carries the current revision.
      if (failure.code === 'stale') await sessions.refreshProjections(rootOf(sessionId))
      return failure
    },
    async changeRequests(sessionId) {
      const result = await ctx.remote.workstreamPanel.changeRequests(sessionId)
      return result.ok ? { ok: true, value: result.value } : { ok: false, failure: failureOf(result.error) }
    },
  }

  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'workstream',
      order: -19,
      locale: NS,
      inject: () => actions,
    }, WorkstreamAction),
  )
}

/**
 * Mount the Workstream panel Remote, then the UI that calls it; the UI is withdrawn before the Remote.
 * @param ctx - client plugin lifetime.
 * @param contribution - generated Workstream panel Remote definitions.
 * @returns the disposer that removes both contributions.
 */
export async function mountWorkstreamPanel(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const unmountRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.workstreamPanel', ...inject.slice(1)], registerUi)
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await unmountRemote()
    throw error
  }
  return async () => {
    await ui.dispose()
    await unmountRemote()
  }
}
