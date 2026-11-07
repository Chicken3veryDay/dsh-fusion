/** The map projection folds only its owner's contiguous revisions and bounds curation attempts per piece of work. */
import { describe, expect, it } from 'vitest'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { contextMapProjectionDefinition, type ContextMapProjectionState } from '../src/projection.ts'
import type { MapSnapshot } from '../src/types.ts'

const OWNER = SessionId('map-projection-owner')
const ACTOR = SessionId('map-projection-actor')

const snapshotAt = (revision: number): MapSnapshot => ({
  ownerSessionId: OWNER, revision, curatorId: null, route: null, indexDigest: null, core: [], groups: [], pending: [],
})

function fold(ops: readonly { kind: 'claim' | 'release'; work?: string; revision?: number }[]): ContextMapProjectionState {
  const session = Session.create(OWNER)
  let state: ContextMapProjectionState = contextMapProjectionDefinition.init(session.header)
  let revision = 0
  for (const op of ops) {
    revision = op.revision ?? revision + 1
    const event: SessionEvent = session.append('context-map/state', {
      version: 1, op: { kind: op.kind, actor: ACTOR, ...op.work === undefined ? {} : { work: op.work } }, snapshot: snapshotAt(revision),
    })
    state = contextMapProjectionDefinition.apply(state, event)
  }
  return state
}

describe('map projection', () => {
  it('rejects a record that skips a revision', () => {
    expect(() => fold([{ kind: 'claim', work: 'w' }, { kind: 'claim', work: 'w', revision: 3 }])).toThrow('Context map revision is not contiguous')
  })

  it('counts a repeated claim of the same work and gives one back per release', () => {
    expect(fold([{ kind: 'claim', work: 'w' }, { kind: 'claim', work: 'w' }]).attempts).toEqual({ work: 'w', count: 2 })
    expect(fold([{ kind: 'claim', work: 'w' }, { kind: 'claim', work: 'w' }, { kind: 'release', work: 'w' }]).attempts).toEqual({ work: 'w', count: 1 })
    expect(fold([{ kind: 'claim', work: 'w' }, { kind: 'release', work: 'w' }]).attempts).toBeNull()
    expect(fold([{ kind: 'claim', work: 'w' }, { kind: 'claim', work: 'other' }]).attempts).toEqual({ work: 'other', count: 1 })
  })
})
