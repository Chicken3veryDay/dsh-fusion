/**
 * Review: `workstream_handoff` promises to transfer the coordinator role "to an active member", but it requires the
 * member to be a resident Agent, and a continuable member is resident only while it runs a turn. The usual unattended
 * sequence (add a member, let it report ready, hand it the role) is therefore refused with a remedy, "resume it", that
 * no model tool performs. The probe also covers evidence across a restart and the owner reclaiming the role.
 */
import { expect, it } from 'vitest'
import { boot, createRoot, makeWorld, readLogs, resumeRoot, runTask, ScriptAdapter, scripted, shutdown, toolResults,
  type ScriptStep } from './review-opus-autonomy-e2e-harness.spec.ts'

const ROOT = 'owner-root'
const load: ScriptStep = () => ({ call: 'context_load', args: { paths: ['Tools'] } })

it('the owner hands the coordinator role to an active member that has finished its turn', async () => {
  const world = await makeWorld()
  const adapter = new ScriptAdapter()
  let memberId = ''
  const owner1: ScriptStep[] = [
    load, load,
    () => ({ call: 'workstream_open', args: { operation_id: 'open', title: 'Handoff' } }),
    () => ({ call: 'workstream_add_member', args: { root_session_id: ROOT, operation_id: 'add-lead', name: 'lead', description: 'leads',
      provider: 'spawn', prompt: 'ROLE:lead' } }),
    (r) => { memberId = (r.at(-1)!.json as { id: string }).id; return { call: 'workstream_create_ticket', args: { root_session_id: ROOT, ticket_id: 't1', subject: 'Do', description: 'Do it' } } },
    () => ({ text: 'waiting for the lead to report ready' }),
    // Woken by the lead's settlement notice ("finished ... ready"): the lead is an active member; hand it the role.
    () => ({ call: 'workstream_get', args: { root_session_id: ROOT } }),
    r => ({ call: 'workstream_handoff', args: { root_session_id: ROOT, expected_revision: (r.at(-1)!.json as { revision: number }).revision, coordinator_id: memberId } }),
    () => ({ call: 'workstream_send', args: { root_session_id: ROOT, operation_id: 'go', target_id: memberId, text: 'publish' } }),
    () => ({ text: 'handed off' }),
  ]
  const lead: ScriptStep[] = [
    load, load, () => ({ text: 'ready' }),
    () => ({ call: 'workstream_evidence_publish', args: { root_session_id: ROOT, operation_id: 'pub-1', artifact_id: 'report', expected_version: 1,
      text: 'EVIDENCE-TEXT-789', name: 'report.md' } }),
    () => ({ call: 'ticket_get', args: { root_session_id: ROOT, ticket_id: 't1' } }),
    () => ({ text: 'published' }),
  ]
  adapter.brain = scripted(request => request.session === ROOT ? owner1 : request.text.includes('ROLE:lead') ? lead : undefined, { text: 'ok' })
  let ctx = await boot(world, adapter)
  const agent = await createRoot(ctx, ROOT)
  expect(await runTask(ctx, agent, 'start')).toBe('idle')
  await shutdown(ctx)

  const adapter2 = new ScriptAdapter()
  const owner2: ScriptStep[] = [
    () => ({ call: 'workstream_evidence_read', args: { root_session_id: ROOT, artifact_id: 'report' } }),
    () => ({ call: 'workstream_get', args: { root_session_id: ROOT } }),
  ]
  adapter2.brain = scripted(request => request.session === ROOT ? owner2 : undefined, { text: 'ok' })
  ctx = await boot(world, adapter2)
  const resumed = await resumeRoot(ctx, ROOT)
  expect(await runTask(ctx, resumed, 'Continue.')).toBe('idle')
  const logs = await readLogs(world.home)
  const owner = toolResults(logs.get(ROOT)!)
  // Control: evidence published by the member survives the restart.
  expect((JSON.parse(owner.find(result => result.name === 'workstream_evidence_read')!.text) as { text: string }).text).toBe('EVIDENCE-TEXT-789')
  const handoff = owner.find(result => result.name === 'workstream_handoff')!
  const after = JSON.parse(owner.at(-1)!.text) as { coordinatorId: string }
  const leadTicket = toolResults(logs.get(memberId)!).find(result => result.name === 'ticket_get')!
  expect({ handoff: handoff.isError ? handoff.text : 'ok', coordinatorAfterRestart: after.coordinatorId === memberId ? 'lead' : after.coordinatorId,
    leadReadsItsTicket: leadTicket.isError ? leadTicket.text : 'ok' },
  'an active member must be able to take the coordinator role between its turns').toEqual({
    handoff: 'ok', coordinatorAfterRestart: 'lead', leadReadsItsTicket: 'ok',
  })
}, 120_000)
