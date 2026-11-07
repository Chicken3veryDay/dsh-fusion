/** A Workstream checkpoint is accepted only when full replay could have produced it, so recovery never loses a commit position. */
import { describe, expect, it } from 'vitest'
import { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ProjectionCheckpoint } from '@deepseek-ai/dsh-session-projection'
import { WorkstreamOperationId } from '../src/ids.ts'
import { workstreamProjectionDefinition as projection } from '../src/projection.ts'
import type { WorkstreamProjectionState } from '../src/projection.ts'
import type { WorkstreamSnapshot } from '../src/types.ts'

const owner = SessionId('owner')
const snapshot: WorkstreamSnapshot = {
  ownerSessionId: owner, coordinatorId: owner, operationId: WorkstreamOperationId('open'), revision: 1, title: 'Work', messages: [],
  members: [{ id: owner, name: 'owner', role: 'owner', description: 'Work', provider: 'owner',
    operationId: WorkstreamOperationId('open'), prompt: '', phase: 'active', diagnostic: null }],
}
const opened: WorkstreamProjectionState = { ownerSessionId: owner, snapshot, snapshotSeq: 0, ticketSeq: null, participantTicketSeqs: {} }
const unopened: WorkstreamProjectionState = { ownerSessionId: owner, snapshot: null, snapshotSeq: null, ticketSeq: null,
  participantTicketSeqs: {} }

describe('Workstream checkpoint validation', () => {
  it('restores the commit position of an opened snapshot exactly as full replay records it', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const { default: Sessions, Session } = await import('@deepseek-ai/dsh-session')
    const { default: Projections } = await import('@deepseek-ai/dsh-session-projection')
    const ctx = new Context()
    try {
      await ctx.plugin(Sessions)
      await ctx.plugin(Projections)
      await ctx.sessionProjections.register(projection)
      const session = Session.create(owner)
      session.append('workstream/state', { version: 1, snapshot })
      const events = session.snapshotEvents()
      const replayed = ctx.sessionProjections.restore({}, events, SessionLogOffset(0), session.header, SessionLogOffset(0))
      // The lossy checkpoint a defective writer could persist: the snapshot without the seq of the event that committed it.
      const lossy: ProjectionCheckpoint = { workstream: { ver: 2, seq: SessionSeq(0), val: { ...opened, snapshotSeq: null } } }
      const lossyFloor = ctx.sessionProjections.restoreFloor(lossy)!
      expect(() => ctx.sessionProjections.restore(lossy, events.slice(lossyFloor), lossyFloor, session.header, SessionLogOffset(0)))
        .toThrow()
      // A consistent checkpoint of the same log restores the identical state.
      const good: ProjectionCheckpoint = { workstream: { ver: 2, seq: SessionSeq(0), val: opened } }
      const floor = ctx.sessionProjections.restoreFloor(good)!
      const restored = ctx.sessionProjections.restore(good, events.slice(floor), floor, session.header, SessionLogOffset(0))
      expect(restored.checkpoint['workstream']?.val).toEqual(replayed.checkpoint['workstream']?.val)
      expect(restored.checkpoint['workstream']?.val).toMatchObject({ snapshotSeq: 0 })
    } finally { await ctx.fiber.dispose() }
  })

  it('accepts every state full replay produces', () => {
    for (const state of [unopened, opened,
      { ...opened, ticketSeq: 3, participantTicketSeqs: { [owner]: 3 } },
      { ...opened, snapshotSeq: 5, ticketSeq: 4, participantTicketSeqs: { [owner]: 4, member: 2 } }])
      expect(projection.stateSchema.safeParse(state).success).toBe(true)
  })

  it('rejects states full replay cannot produce', () => {
    const inconsistent: Record<string, unknown> = {
      'snapshot without its committing seq': { ...opened, snapshotSeq: null },
      'committing seq without a snapshot': { ...unopened, snapshotSeq: 0 },
      'Ticket position before the Workstream opened': { ...unopened, ticketSeq: 1, participantTicketSeqs: { [owner]: 1 } },
      'participant positions without a Ticket position': { ...opened, participantTicketSeqs: { [owner]: 2 } },
      'Ticket position without participants': { ...opened, ticketSeq: 2 },
      'participant ahead of the latest Ticket position': { ...opened, ticketSeq: 2, participantTicketSeqs: { [owner]: 3 } },
      'latest Ticket position no participant reached': { ...opened, ticketSeq: 3, participantTicketSeqs: { [owner]: 2 } },
      'participants recorded before the Workstream opened': { ...unopened, participantTicketSeqs: { [owner]: 1 } },
    }
    for (const [name, state] of Object.entries(inconsistent)) expect(projection.stateSchema.safeParse(state).success, name).toBe(false)
  })
})
