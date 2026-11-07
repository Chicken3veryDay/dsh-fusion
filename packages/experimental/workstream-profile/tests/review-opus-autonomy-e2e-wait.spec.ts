/**
 * Review: `workstream_wait` promises to wait "for a durable Workstream or Ticket event", but its only cursor is the
 * Workstream revision. A member that asks a Ticket question, reads the Ticket (still open), and then waits misses an
 * answer that landed between its read and its wait: the wait blocks for the whole timeout although the event it waits
 * for has already happened, and nothing else wakes it in an unattended run whose owner is idle.
 */
import { expect, it } from 'vitest'
import { boot, createRoot, makeWorld, readLogs, runTask, ScriptAdapter, scripted, toolResults, type Brain,
  type ScriptStep } from './review-opus-autonomy-e2e-harness.spec.ts'

const ROOT = 'owner-root'
const TIMEOUT_MS = 20_000
const load: ScriptStep = () => ({ call: 'context_load', args: { paths: ['Tools'] } })

it('a member waiting for its Ticket answer wakes for an answer committed after its last read', async () => {
  const world = await makeWorld()
  const adapter = new ScriptAdapter()
  let memberId = ''
  let revision = 0
  const answered = Promise.withResolvers<undefined>()
  const memberRead = Promise.withResolvers<undefined>()
  const timing = { waitStarted: 0, waitEnded: 0 }
  const owner: ScriptStep[] = [
    load, load,
    () => ({ call: 'workstream_open', args: { operation_id: 'open', title: 'Questions' } }),
    () => ({ call: 'workstream_add_member', args: { root_session_id: ROOT, operation_id: 'add-asker', name: 'asker', description: 'asks',
      provider: 'spawn', prompt: 'ROLE:asker' } }),
    (r) => { memberId = (r.at(-1)!.json as { id: string }).id; return { call: 'workstream_create_ticket', args: { root_session_id: ROOT, ticket_id: 't1', subject: 'Do', description: 'Do it' } } },
    () => ({ call: 'workstream_assign_ticket', args: { root_session_id: ROOT, ticket_id: 't1', expected_revision: 1, owner_id: memberId, subject: 'Part' } }),
    () => ({ call: 'workstream_send', args: { root_session_id: ROOT, operation_id: 'go', target_id: memberId, text: 'go' } }),
  ]
  const asker: ScriptStep[] = [
    load, load, () => ({ text: 'ready' }),
    () => ({ call: 'ticket_claim', args: { root_session_id: ROOT, ticket_id: 't1', assignment_id: 'assignment-t1-1', expected_revision: 2 } }),
    () => ({ call: 'ticket_ask', args: { root_session_id: ROOT, ticket_id: 't1', assignment_id: 'assignment-t1-1', expected_revision: 3,
      question: 'Which interface?' } }),
    () => ({ call: 'workstream_send', args: { root_session_id: ROOT, operation_id: 'ask-owner', target_id: ROOT, text: 'please answer my Ticket question' } }),
    () => ({ call: 'workstream_get', args: { root_session_id: ROOT } }),
    (r) => { revision = (r.at(-1)!.json as { revision: number }).revision; return { call: 'ticket_get', args: { root_session_id: ROOT, ticket_id: 't1' } } },
    async (r) => {
      expect((r.at(-1)!.json as { questions: { status: string }[] }).questions.map(question => question.status)).toEqual(['open'])
      // The coordinator answers now, after the member's read and before its wait, and then has nothing left to do.
      memberRead.resolve(undefined)
      await answered.promise
      await new Promise(resolve => setTimeout(resolve, 500))
      timing.waitStarted = Date.now()
      return { call: 'workstream_wait', args: { root_session_id: ROOT, after_revision: revision, timeout_ms: TIMEOUT_MS } }
    },
    () => { timing.waitEnded = Date.now(); return { text: 'got my answer' } },
  ]
  let answering: 'no' | 'asked' | 'done' = 'no'
  const members = scripted(request => request.session === ROOT ? owner : request.text.includes('ROLE:asker') ? asker : undefined, { text: 'ok' })
  const brain: Brain = async (request, step, last) => {
    if (request.session === ROOT && request.text.includes('please answer my Ticket question') && answering === 'no') {
      answering = 'asked'
      await memberRead.promise
      return { call: 'ticket_answer', args: { root_session_id: ROOT, ticket_id: 't1', question_id: 'question-t1-1', expected_revision: 4,
        answer: 'Use the shared interface.' } }
    }
    if (request.session === ROOT && answering === 'asked') {
      answering = 'done'
      answered.resolve(undefined)
      return { text: 'answered' }
    }
    return members(request, step, last)
  }
  adapter.brain = brain
  const ctx = await boot(world, adapter)
  const agent = await createRoot(ctx, ROOT)
  expect(await runTask(ctx, agent, 'start', 60_000)).toBe('idle')
  const logs = await readLogs(world.home)
  expect(toolResults(logs.get(ROOT)!).find(result => result.name === 'ticket_answer')?.isError).toBe(false)
  const wait = toolResults(logs.get(memberId)!).find(result => result.name === 'workstream_wait')!
  const anyNumber: unknown = expect.any(Number)
  expect({ result: JSON.parse(wait.text) as unknown, blockedMs: timing.waitEnded - timing.waitStarted < 5_000 ? 'under 5s' : timing.waitEnded - timing.waitStarted },
    'the answer the member waits for was already committed; the wait must not block until its timeout')
    // The wait result gained `cursor` (chained into the next wait, fix-ws-wait round 2); the timing assertion is unchanged.
    .toEqual({ result: { timedOut: false, revision: anyNumber, cursor: anyNumber }, blockedMs: 'under 5s' })
}, 120_000)
