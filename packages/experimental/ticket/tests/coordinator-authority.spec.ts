import { describe, expect, it, onTestFinished } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TicketService from '../src/index.ts'
import { ticketActor } from './ticket-actor.ts'

async function harness() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(TicketService)
  return { ctx, session: ctx.sessions.create(SessionId('authority-root')) }
}

describe('Ticket coordinator authority', () => {
  it('names the replacement the authority decides, keeps requests it leaves alone, and stops after disposal', async () => {
    const { ctx, session } = await harness()
    const replacement = SessionId('replacement-coordinator')
    await ticketActor(ctx, replacement, async () => {})
    await ticketActor(ctx, SessionId('requested'), async () => {})
    const requests: SessionId[] = []
    const dispose = ctx.tickets.registerCoordinatorAuthority((candidate, requested) => {
      requests.push(requested)
      return candidate === session && requested === session.id ? replacement : undefined
    })
    const defaulted = await ticketActor(ctx, session.id, () => ctx.tickets.create(session, { subject: 'Defaulted', description: '' }))
    expect(defaulted.coordinatorId).toBe(replacement)
    const explicit = await ticketActor(ctx, session.id, () => ctx.tickets.create(session,
      { subject: 'Explicit', description: '', coordinatorId: SessionId('requested') }))
    expect(explicit.coordinatorId).toBe('requested')
    expect(requests).toEqual([session.id, SessionId('requested')])
    const other = ctx.sessions.create(SessionId('unclaimed-root'))
    const unclaimed = await ticketActor(ctx, other.id, () => ctx.tickets.create(other, { subject: 'Unclaimed', description: '' }))
    expect(unclaimed.coordinatorId).toBe(other.id)
    dispose()
    const released = await ticketActor(ctx, session.id, () => ctx.tickets.create(session, { subject: 'Released', description: '' }))
    expect(released.coordinatorId).toBe(session.id)
  })

  it('reads the authority at the append, so a creation queued before an authority change names the new coordinator', async () => {
    const { ctx, session } = await harness()
    // The authority changes its answer as soon as the first creation has consulted it.
    await ticketActor(ctx, SessionId('before'), async () => {})
    await ticketActor(ctx, SessionId('after'), async () => {})
    const answers = [SessionId('before'), SessionId('after')]
    ctx.tickets.registerCoordinatorAuthority(() => answers.shift())
    const [first, second] = await ticketActor(ctx, session.id, async () => {
      const queuedFirst = ctx.tickets.create(session, { subject: 'First', description: '' })
      const queuedSecond = ctx.tickets.create(session, { subject: 'Second', description: '' })
      return Promise.all([queuedFirst, queuedSecond])
    })
    expect(first.coordinatorId).toBe('before')
    expect(second.coordinatorId).toBe('after')
  })

  it('fails creation without appending when the authority throws', async () => {
    const { ctx, session } = await harness()
    ctx.tickets.registerCoordinatorAuthority(() => { throw new Error('authority unavailable') })
    await expect(ticketActor(ctx, session.id, () => ctx.tickets.create(session, { subject: 'Rejected', description: '' })))
      .rejects.toMatchObject({ message: 'Ticket coordinator authority failed', cause: { message: 'authority unavailable' } })
    expect(ctx.tickets.list(session)).toEqual([])
    expect(session.snapshotEvents().filter(event => event.type === 'ticket/state')).toEqual([])
  })
})
