/**
 * Review: `workstream_add_member` while running members fill the root's Subagent activation pool. Subagent refuses the
 * activation before any child exists (`ACTIVATION_LIMIT_REACHED`), but Workstream records the member as `provisioning`,
 * reports the outcome as uncertain, and tells the model to retry the same operation; the retry can never succeed.
 */
import { expect, it } from 'vitest'
import { boot, createRoot, makeWorld, readLogs, runTask, ScriptAdapter, scripted, toolResults,
  type ScriptStep } from './review-opus-autonomy-e2e-harness.spec.ts'

const ROOT = 'owner-root'
const load: ScriptStep = () => ({ call: 'context_load', args: { paths: ['Tools'] } })

it.each([
  ['shipped composition (maxActiveSubagents 8)', []],
  ['control: a pool with room for nine members (maxActiveSubagents 16)', ['- id: subagent', '  config:', '    maxActiveSubagents: 16']],
] as const)('a ninth member added while eight members run is active after retrying the same operation: %s', async (_label, extra) => {
  const world = await makeWorld({ extra: [...extra] })
  const adapter = new ScriptAdapter()
  const release = Promise.withResolvers<undefined>()
  const add = (i: number): ScriptStep => () => ({ call: 'workstream_add_member', args: { root_session_id: ROOT, operation_id: `add-${String(i)}`,
    name: `m${String(i)}`, description: 'member', provider: 'spawn', prompt: `ROLE:member-${String(i)}` } })
  const owner: ScriptStep[] = [load, load, () => ({ call: 'workstream_open', args: { operation_id: 'open', title: 'Big team' } }),
    ...Array.from({ length: 9 }, (_, i) => add(i + 1)),
    () => { release.resolve(undefined); return { text: 'wait for the members' } },
    // Woken by the settlement notices once the first eight finished: retry exactly as the error instructs.
    add(9), () => ({ call: 'workstream_get', args: { root_session_id: ROOT } })]
  const busy: ScriptStep[] = [async () => { await release.promise; return { text: 'ready' } }]
  adapter.brain = scripted(request => request.session === ROOT ? owner : busy, { text: 'ready' })
  const ctx = await boot(world, adapter)
  const agent = await createRoot(ctx, ROOT)
  expect(await runTask(ctx, agent, 'start')).toBe('idle')
  const results = toolResults((await readLogs(world.home)).get(ROOT)!).filter(result => result.name.startsWith('workstream_'))
  const adds = results.filter(result => result.name === 'workstream_add_member')
  const final = JSON.parse(results.at(-1)!.text) as { members: { name: string; phase: string }[] }
  expect(adds.slice(0, 8).every(result => !result.isError)).toBe(true)
  expect({
    firstNinth: adds[8]!.text,
    retry: adds[9]!.isError ? adds[9]!.text : (JSON.parse(adds[9]!.text) as { phase: string }).phase,
    phase: final.members.find(member => member.name === 'm9')?.phase,
  }, 'a capacity refusal is definite: the retry the error asks for must provision the member once capacity returns').toEqual({
    firstNinth: expect.not.stringContaining('remains uncertain') as string,
    retry: 'active',
    phase: 'active',
  })
}, 120_000)
