/** Evidence for the restart fix report's explicitly deferred tool-history behavior. */
import { createDeveloperMessage, projectToolUpdates, type ToolSchema } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'

it('drops the replacement notice at adapter projection while retaining exact active declarations', () => {
  const probe: ToolSchema = { name: 'probe', description: 'Probe', parameters: {} }
  const fetch: ToolSchema = { name: 'fetch', description: 'Fetch', parameters: {} }
  const other: ToolSchema = { name: 'other', description: 'Other', parameters: {} }
  const config = { provider: 'mock', model: 'model' }
  const session = Session.create(SessionId('review-r11-history-fallback'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', { reason: 'initial', header: { config, tools: [probe] } })
  const abandonedHeader = session.append('request/header', {
    reason: 'change', header: { config, tools: [probe, fetch, other] },
  })
  const abandonedNotice = session.append('developer/message', {
    turn: 1, step: 1, headerSeq: abandonedHeader.seq,
    message: createDeveloperMessage({ source: { kind: 'tool-registry' }, content: [
      { type: 'tool-addition', toolName: 'fetch' }, { type: 'tool-addition', toolName: 'other' },
    ] }),
  }, { surfaceOp: 'append' })
  const restartedHeader = session.append('request/header', {
    reason: 'change', header: { config, tools: [probe, other] },
  })
  const replacement = createDeveloperMessage({ source: { kind: 'tool-registry' }, content: [
    { type: 'tool-addition', toolName: 'other' },
  ] })
  session.append('developer/message', {
    turn: 1, step: 1, headerSeq: restartedHeader.seq, message: replacement,
  }, {
    surfaceOp: { op: 'replace', startSeq: abandonedNotice.seq, endSeq: abandonedNotice.seq },
    sourceEventSeqs: [abandonedNotice.seq],
  })

  const messages = session.deriveMessages()
  expect(messages.map(message => message.id)).toContain(replacement.id)
  const history = session.toolHistory()
  expect(history).toEqual({ tools: [probe, other], updates: [] })
  const projected = projectToolUpdates(messages, [probe, other], 'in-history', history)
  expect(projected.tools).toEqual([probe, other])
  expect(projected.messages.some(message => message.role === 'developer')).toBe(false)
})
