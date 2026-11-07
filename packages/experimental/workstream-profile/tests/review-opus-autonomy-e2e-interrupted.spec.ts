/**
 * Review: a member is mid-turn on its claimed Ticket assignment when the process shuts down. After the restart the
 * member is not resumed, and nothing the resumed owner sees says its turn was aborted: Workstream lists it `active`
 * with no diagnostic, Ticket shows its assignment `running`, and the owner's history ends with the member's earlier
 * "finished ... ready" notice. An unattended owner waits for a report that will never come.
 */
import { expect, it } from 'vitest'
import { boot, createRoot, makeWorld, readLogs, resumeRoot, runTask, ScriptAdapter, scripted, shutdown, toolResults,
  type ScriptStep } from './review-opus-autonomy-e2e-harness.spec.ts'

const ROOT = 'owner-root'
/** The `workstream_get` and `ticket_get` result fields this test reads. */
interface OwnerRead {
  readonly members: readonly { readonly id: string; readonly phase: string; readonly diagnostic: string | null }[]
  readonly assignments: readonly { readonly status: string }[]
  readonly attempts: readonly unknown[]
}
const load: ScriptStep = () => ({ call: 'context_load', args: { paths: ['Tools'] } })

it('after a restart, a member whose turn the shutdown aborted is resumed or reported to the owner', async () => {
  const world = await makeWorld()
  const adapter = new ScriptAdapter()
  let memberId = ''
  const working = Promise.withResolvers<undefined>()
  const owner1: ScriptStep[] = [
    load, load,
    () => ({ call: 'workstream_open', args: { operation_id: 'open', title: 'Ship it' } }),
    () => ({ call: 'workstream_add_member', args: { root_session_id: ROOT, operation_id: 'add-w', name: 'writer', description: 'writes',
      provider: 'spawn', prompt: 'ROLE:writer' } }),
    (r) => { memberId = (r.at(-1)!.json as { id: string }).id; return { call: 'workstream_create_ticket', args: { root_session_id: ROOT, ticket_id: 't1', subject: 'Do', description: 'Do it' } } },
    () => ({ call: 'workstream_assign_ticket', args: { root_session_id: ROOT, ticket_id: 't1', expected_revision: 1, owner_id: memberId, subject: 'Part' } }),
    () => ({ call: 'workstream_send', args: { root_session_id: ROOT, operation_id: 'go-1', target_id: memberId, text: 'go' } }),
    () => ({ text: 'waiting for the writer' }),
  ]
  const writer: ScriptStep[] = [
    load, load, () => ({ text: 'ready' }),
    () => ({ call: 'ticket_claim', args: { root_session_id: ROOT, ticket_id: 't1', assignment_id: 'assignment-t1-1', expected_revision: 2 } }),
    () => { working.resolve(undefined); return { hang: true } },
  ]
  adapter.brain = scripted(request => request.session === ROOT ? owner1 : request.text.includes('ROLE:writer') ? writer : undefined)
  let ctx = await boot(world, adapter)
  const owner = await createRoot(ctx, ROOT)
  const run = runTask(ctx, owner, 'start', 30_000)
  await working.promise
  await new Promise(resolve => setTimeout(resolve, 300))
  await shutdown(ctx)
  void run.catch(() => undefined)

  const adapter2 = new ScriptAdapter()
  const owner2: ScriptStep[] = [
    () => ({ call: 'workstream_get', args: { root_session_id: ROOT } }),
    () => ({ call: 'ticket_get', args: { root_session_id: ROOT, ticket_id: 't1' } }),
    r => ({ call: 'workstream_wait', args: { root_session_id: ROOT, after_revision: (r.at(-2)!.json as { revision: number }).revision, timeout_ms: 3000 } }),
  ]
  adapter2.brain = scripted(request => request.session === ROOT ? owner2 : undefined, { text: 'resumed member' })
  ctx = await boot(world, adapter2)
  const resumed = await resumeRoot(ctx, ROOT)
  expect(await runTask(ctx, resumed, 'Continue the Workstream.', 30_000)).toBe('idle')
  const logs = await readLogs(world.home)
  const firstOwnerRequest = adapter2.requests.find(request => request.session === ROOT)!
  const results = toolResults(logs.get(ROOT)!).slice(-3)
  const [workstream, ticket] = results.map(result => JSON.parse(result.text) as OwnerRead)
  const member = workstream!.members.find((candidate: { id: string }) => candidate.id === memberId)!
  // What the owner reads durably: no Workstream diagnostic, and the assignment still `running` with no attempt record.
  expect({ phase: member.phase, diagnostic: member.diagnostic, assignment: ticket!.assignments[0]!.status, attempts: ticket!.attempts })
    .toEqual({ phase: 'active', diagnostic: null, assignment: 'running', attempts: [] })
  // Everything the resumed owner's model saw after its own last pre-restart message.
  const since = firstOwnerRequest.text.slice(firstOwnerRequest.text.lastIndexOf('waiting for the writer'))
  expect({
    memberResumed: adapter2.requests.some(request => request.session === memberId),
    ownerToldOfAbortedTurn: since.includes(memberId),
    workstreamDiagnostic: member.diagnostic !== null,
  }, 'the aborted member turn must be resumed or visibly reported after the restart').not.toEqual({
    memberResumed: false, ownerToldOfAbortedTurn: false, workstreamDiagnostic: false,
  })
}, 120_000)
