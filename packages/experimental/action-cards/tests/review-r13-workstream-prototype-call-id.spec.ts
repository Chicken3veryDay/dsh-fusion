/** Admitted call ids retain cards and supersession through the public readers. */
import { expect, it } from 'vitest'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { ACTION, fixture, proposal, SKILL } from './fixture.ts'

for (const id of ['ordinary-card', '__proto__', 'constructor', 'toString']) {
  it(`settles superseded call ${id} before dispatching its old action`, async () => {
    const f = await fixture()
    const callId = ToolCallId(id)
    f.propose(callId)
    f.propose(ToolCallId('new-card'), proposal, f.agent, 2)
    const result = await f.ctx.actionCards.act(f.agent, callId, 'start')
    expect(result).toEqual({ status: 'settled', decision: { callId, action: ACTION, phase: 'replaced' } })
    expect(f.act).not.toHaveBeenCalled()
  })
}

for (const id of ['ordinary-card', '__proto__']) {
  it(`publishes the successful model-issued card ${id} to the Client projection`, async () => {
    const f = await fixture()
    const adapter = new MockAdapter([
      toolCallResponse('load-card-skill', 'skill', { name: SKILL }),
      toolCallResponse(id, 'propose_action', proposal),
      textResponse('The card is below.'),
    ])
    f.ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await f.harness.create(SessionId('review-card-model'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Show a counter.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const result = agent.session.snapshotEvents().find(event => event.type === 'tool/result' && event.data.message.toolCallId === id)
    const shown: unknown = expect.stringContaining('Card shown below your answer.')
    expect(result).toMatchObject({ type: 'tool/result', data: { message: { isError: false,
      content: [{ type: 'text', text: shown }] } } })
    expect(Object.hasOwn(f.view(agent).proposals, id)).toBe(true)
    const wire: unknown = f.ctx.sessionProjections.snapshot(agent.session, ['actionCards']).values['actionCards']
    expect(wire).toMatchObject({ proposals: { [id]: { callId: id, ...proposal } } })
  })
}
