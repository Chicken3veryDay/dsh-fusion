/** Validated root roster and provisioning evidence folded from required log-only records. */
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { rosterSchema } from './roster.ts'
import type { Roster } from './roster.ts'
import type {} from './index.ts'

/** Authoritative root state; a missing roster never means a new task. */
export interface RosterState {
  readonly roster: Roster | null
  readonly established: readonly ReturnType<typeof SessionId>[]
}
const established = z.strictObject({ participantId: z.string().min(1).transform(SessionId) })
/** Required record parser and incremental root fold. */
export const rosterProjection = {
  key: 'fusionRoster',
  stateVersion: 1,
  stateSchema: z.object({ roster: rosterSchema.nullable(), established: z.array(z.string().transform(SessionId)) }),
  init: () => ({ roster: null, established: [] }),
  apply(state, event) {
    if (event.type === 'fusion/roster') {
      if (state.roster !== null) throw new Error('duplicate immutable root roster')
      return { ...state, roster: rosterSchema.parse(event.data) }
    }
    if (event.type === 'fusion/participant-established') {
      const { participantId } = established.parse(event.data)
      if (state.roster === null || !state.roster.participants.some(row => row.id === participantId)
        || state.established.includes(participantId)) throw new Error('invalid participant provisioning evidence')
      return { ...state, established: [...state.established, participantId] }
    }
    return state
  },
} satisfies ProjectionDefinition<'fusionRoster', RosterState>
