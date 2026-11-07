/**
 * Review probe: the background curator shares the root's Subagent activation pool with Workstream members. While the
 * members fill the pool, every owner step announces a member's pending note; does that note get curated once the
 * members finish?
 */
import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { boot, createRoot, makeWorld, readLogs, runTask, ScriptAdapter, scripted, type Brain, type Request, type ScriptStep,
  type Step } from '../../workstream-profile/tests/review-opus-autonomy-e2e-harness.spec.ts'

const ROOT = 'owner-root'
const CURATOR = 'You are the project map curator'
const load: ScriptStep = () => ({ call: 'context_load', args: { paths: ['Tools'] } })

/** The `map_view` result fields the scripted curator reads. */
interface MapViewResult {
  readonly revision?: number
  readonly groups?: unknown
  readonly pending?: unknown
}

const isList = (value: unknown): value is readonly { readonly id: string }[] => Array.isArray(value)

/** A curator that groups the shell tools once and files every pending note into the first group. */
function curate(request: Request): Step {
  const last = request.options.messages.at(-1)
  if (last?.role !== 'tool') return { call: 'map_view', args: {} }
  const text = last.content.map(block => ('text' in block ? block.text : '')).join('')
  let view: MapViewResult | undefined
  try { view = JSON.parse(text) as MapViewResult } catch { view = undefined }
  if (view === undefined || !isList(view.groups) || !isList(view.pending)) {
    return text.includes('"op"') || text.startsWith('{') ? { call: 'map_view', args: {} } : { text: 'Map is up to date.' }
  }
  if (view.groups.length === 0) {
    return { call: 'map_group', args: { action: 'set', expected_revision: view.revision, path: 'Tools/Global/shell', title: 'Shell tools',
      summary: 'Use when running commands.', tools: ['bash'] } }
  }
  if (view.pending.length > 0) {
    return { call: 'map_note', args: { action: 'file', expected_revision: view.revision, pending_id: view.pending[0]!.id, group_id: view.groups[0]!.id } }
  }
  return { text: 'Map is up to date.' }
}

it.each([
  ['shipped composition (maxActiveSubagents 8)', []],
  ['control: a pool with room for the curator (maxActiveSubagents 16)', ['- id: subagent', '  config:', '    maxActiveSubagents: 16']],
] as const)('a member note filed while eight members run is curated after they finish: %s', async (_label, extra) => {
  const world = await makeWorld({ extra: [...extra] })
  const adapter = new ScriptAdapter()
  const release = Promise.withResolvers<undefined>()
  const noted = Promise.withResolvers<undefined>()
  const added = Promise.withResolvers<undefined>()
  const add = (i: number): ScriptStep => () => ({ call: 'workstream_add_member', args: { root_session_id: ROOT, operation_id: `add-${String(i)}`,
    name: `m${String(i)}`, description: 'member', provider: 'spawn', prompt: `ROLE:member-${String(i)}` } })
  const get = (): Step => ({ call: 'workstream_get', args: { root_session_id: ROOT } })
  const owner: ScriptStep[] = [
    load, load, () => ({ call: 'workstream_open', args: { operation_id: 'open', title: 'Busy team' } }),
    ...Array.from({ length: 8 }, (_, i) => add(i + 1)),
    async () => { added.resolve(undefined); await noted.promise; return get() },
    get, get, get,
    () => {
      release.resolve(undefined)
      return { text: 'members may finish' }
    },
    // Woken by the members' settlement notices: ordinary owner steps after the pool has room again.
    get, get, get, get,
  ]
  const busy: ScriptStep[] = [async () => { await release.promise; return { text: 'done' } }]
  const noter: ScriptStep[] = [
    async () => { await added.promise; return { call: 'context_note', args: { text: 'Tests run with vitest.', cites: ['ref:package.json test script'] } } },
    async () => { noted.resolve(undefined); await release.promise; return { text: 'done' } },
  ]
  const members = scripted(request => request.session === ROOT ? owner : request.text.includes('ROLE:member-1') ? noter : busy, { text: 'ok' })
  const brain: Brain = (request, step, last) => request.text.includes(CURATOR) ? curate(request) : members(request, step, last)
  adapter.brain = brain
  const ctx = await boot(world, adapter)
  const agent = await createRoot(ctx, ROOT)
  expect(await runTask(ctx, agent, 'start', 90_000)).toBe('idle')
  await ctx.contextCurator.idle(SessionId(ROOT))
  const map = ctx.contextMap.snapshotOf(agent)
  const ops = [...(await readLogs(world.home)).get(ROOT)!].filter(event => event.type === 'context-map/state')
    .map(event => (event.data as { op: { kind: string } }).op.kind)
  // The map log shows why: each claim of the same work is released without a curator request in between.
  const claims = ops.filter(op => op === 'claim').length
  const curatorRequests = adapter.requests.filter(request => request.text.includes(CURATOR)).length
  expect(claims).toBeGreaterThan(0)
  expect({ pending: map.pending.map(note => note.text), filed: map.groups.flatMap(group => group.notes.map(note => note.text)) },
    `the member note must be curated once the members free the pool (claims ${String(claims)}, curator requests ${String(curatorRequests)}, ops ${ops.join(',')})`)
    .toEqual({ pending: [], filed: ['Tests run with vitest.'] })
}, 150_000)
