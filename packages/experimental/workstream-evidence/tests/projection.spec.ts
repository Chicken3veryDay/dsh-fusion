import { expect, it } from 'vitest'
import { appendPluginRecord, Session, SessionId } from '@deepseek-ai/dsh-session'
import { WORKSTREAM_EVIDENCE_RECORD, workstreamEvidenceProjectionDefinition as projection } from '../src/projection.ts'

it('ignores inherited snapshots and rejects noncontiguous evidence revisions', () => {
  const session = Session.create(SessionId('root'))
  const state = projection.init(session.header)
  appendPluginRecord(session, WORKSTREAM_EVIDENCE_RECORD, {
    version: 1, snapshot: { ownerSessionId: SessionId('parent'), revision: 1, artifacts: [] },
  })
  appendPluginRecord(session, WORKSTREAM_EVIDENCE_RECORD, {
    version: 1, snapshot: { ownerSessionId: SessionId('root'), revision: 2, artifacts: [] },
  })
  const [inherited, skipped] = session.snapshotEvents()
  expect(projection.apply(state, inherited!)).toBe(state)
  expect(() => projection.apply(state, skipped!)).toThrow('revision is not contiguous')
  expect(projection.wire.view(state)).toBeNull()
  appendPluginRecord(session, WORKSTREAM_EVIDENCE_RECORD, {
    version: 1, snapshot: { ownerSessionId: SessionId('root'), revision: 1, artifacts: [] },
  })
  const restored = projection.apply(state, session.snapshotEvents().at(-1)!)
  expect(projection.wire.view(restored)).toBe(restored.snapshot)
  expect(projection.wire.viewSchema.parse(projection.wire.view(restored))).toEqual({
    ownerSessionId: SessionId('root'), revision: 1, artifacts: [],
  })
})
