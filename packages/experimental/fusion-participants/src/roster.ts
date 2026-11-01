/** Immutable task membership and exact frozen route selection. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Selection } from '@deepseek-ai/dsh-fusion-config'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'

const id = z.string().min(1).transform(SessionId)
const binding = z.strictObject({
  catalogRevision: z.string().min(1), presetId: z.string().min(1), canonicalModelId: z.string().min(1),
  family: z.enum(['OpenAI', 'Anthropic']), providerId: z.string().min(1), adapterId: z.literal('llm-pi-ai'),
  transport: z.enum(['openai-responses', 'anthropic-messages']), wireModelId: z.string().min(1),
  baseURL: z.url().refine((value) => {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
  }, 'route must not contain credentials, queries or fragments'), credentialRef: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u).transform(credentialRef),
  effort: z.enum(['low', 'medium', 'high']),
})
/** Durable roster parser; unknown fields, duplicate identities and missing role targets refuse recovery. */
export const rosterSchema = z.strictObject({
  version: z.literal(1), rootSessionId: id,
  compositionDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  selectionId: z.string().min(1), selectionRevision: z.string().min(1), agentPreset: z.string().min(1),
  mode: z.enum(['fusion', 'single']), runtime: z.literal('quickjs-script'), tier: z.enum(['top', 'middle', 'low', 'single']),
  participants: z.array(z.strictObject({ id, role: z.string().min(1), binding })).min(1),
  upgrades: z.array(binding),
  roles: z.record(z.string().min(1), id),
}).superRefine((roster, ctx) => {
  const ids = new Set(roster.participants.map(row => row.id))
  const sorted = roster.participants.map(row => row.id).sort()
  const roles = new Set(roster.participants.map(row => row.role))
  const required = roster.tier === 'single' ? ['participant', 'decider']
    : roster.tier === 'top' ? ['userFacingLead', 'otherCoLead', 'executor', 'decider', 'takeover']
      : ['lead', 'executor', 'decider', 'takeover']
  if (ids.size !== roster.participants.length || ids.has(roster.rootSessionId)
    || roles.size !== roster.participants.length
    || roster.participants.some((row, index) => roster.roles[row.role] !== row.id
      || row.id !== sorted[index])
    || Object.values(roster.roles).some(value => !ids.has(value))
    || required.some(role => roster.roles[role] === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'invalid participant identities or roles' })
  }
  if ((roster.mode === 'single') !== (roster.tier === 'single')
    || roster.tier === 'single' && (roster.participants.length !== 1 || roster.roles.decider !== roster.roles.participant)) {
    ctx.addIssue({ code: 'custom', message: 'invalid single-agent topology' })
  }
  if (roster.tier === 'top' && roster.roles.userFacingLead === roster.roles.otherCoLead) {
    ctx.addIssue({ code: 'custom', message: 'Top requires distinct co-leads' })
  }
})
/** Root-owned identity map, containing binding references but no credentials or transcript. */
export type Roster = z.infer<typeof rosterSchema>

/**
 * Allocate stable identities once, following only explicit authority links.
 * @param selection - frozen fusion-config selection.
 * @param compositionDigest - digest of the pinned preset declaration.
 * @returns detached immutable roster; exact bindings are never substituted or upgraded.
 */
export function captureRoster(selection: Selection, compositionDigest: string): Roster {
  const rootSessionId = SessionId(randomUUID())
  const roles: Record<string, ReturnType<typeof SessionId>> = {}
  const participants: Roster['participants'] = []
  for (const [role, selected] of Object.entries(selection.roles)) {
    if ((role === 'decider' && selection.authority.decider !== 'decider') || role === 'takeover') continue
    const participantId = SessionId(randomUUID())
    roles[role] = participantId
    participants.push({ id: participantId, role, binding: structuredClone(selected) })
  }
  const decider = roles[selection.authority.decider]
  if (decider === undefined) throw new Error('selection has no decider participant')
  roles.decider = decider
  if (selection.authority.takeover !== null) {
    const takeover = roles[selection.authority.takeover]
    if (takeover === undefined) throw new Error('selection has no takeover participant')
    roles.takeover = takeover
  }
  return deepFreeze(rosterSchema.parse({
    version: 1, rootSessionId, compositionDigest, selectionId: selection.id, selectionRevision: selection.revision,
    agentPreset: selection.agentPreset, mode: selection.mode, runtime: selection.runtime, tier: selection.tier,
    upgrades: structuredClone(selection.upgrades),
    participants: participants.sort((a, b) => a.id.localeCompare(b.id)), roles,
  }))
}
