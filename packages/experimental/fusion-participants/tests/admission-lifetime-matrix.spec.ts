/** Every admission entry refuses at each task lifetime's teardown cutoff while admitted work drains. */
import { expect, it } from 'vitest'
import { FiberState } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import Participants, { DeliveryId } from '../src/index.ts'
import type { AdmissionSnapshot, ExecutionHostProvider } from '../src/index.ts'
import { mount, read } from './harness.ts'

/** `service` is the opt-in owner fiber; `execution-owner` is direct execution-owner disposal through its host. */
type Lifetime = 'caller' | 'caller-ancestor' | 'host' | 'host-ancestor' | 'service' | 'execution-owner'
/** Earlier observers precede every Fusion listener; later ones follow them; held disposal also probes its cleanup window. */
type Teardown = 'restart-early' | 'restart-late' | 'dispose-held'
interface Observation {
  readonly delivery: AdmissionSnapshot
  readonly attempts: readonly string[]
  readonly grant: { readonly generation: number; readonly owner: string | null }
  readonly enrolled: boolean
}

const fiberLifetimes = ['caller', 'caller-ancestor', 'host', 'host-ancestor', 'service'] as const
const cells: [Lifetime, Teardown][] = [
  ...fiberLifetimes.flatMap(lifetime => (['restart-early', 'restart-late', 'dispose-held'] as const).map((teardown): [Lifetime, Teardown] => [lifetime, teardown])),
  ['execution-owner', 'dispose-held'],
]

it.each(cells)('refuses every admission entry at the %s %s cutoff', async (lifetime, teardown) => {
  const { ctx, adapter } = await mount()
  const service = [...ctx.registry.get(Participants)!.fibers][0]!
  const callerParent = lifetime === 'caller-ancestor' ? createScope(ctx, {}) : undefined
  const caller = createScope(callerParent?.ctx ?? ctx, {})
  const hostParent = lifetime === 'host-ancestor' ? createScope(ctx, {}) : undefined
  const declaring = createScope(hostParent?.ctx ?? ctx, {})
  const scope = lifetime === 'caller' ? caller : lifetime === 'caller-ancestor' ? callerParent
    : lifetime === 'host' ? declaring : lifetime === 'host-ancestor' ? hostParent : undefined
  const watched: Context['fiber'] | undefined = lifetime === 'execution-owner' ? undefined : scope?.ctx.fiber ?? service
  let probe: (() => void) | undefined
  const observe = () => ctx.root.on('internal/status', (fiber) => {
    if (fiber === watched && fiber.state === FiberState.UNLOADING) probe?.()
  })
  let removeObserver = teardown === 'restart-late' ? undefined : observe()
  const counts = { registrations: 0, preparations: 0, bodies: 0, cleanups: 0 }
  const entered = Promise.withResolvers<undefined>(), gate = Promise.withResolvers<undefined>()
  if (teardown !== 'dispose-held') gate.resolve(undefined)
  const provider = (name: string): ExecutionHostProvider => ({
    name, revision: '1', classify: () => 'read',
    registerHeld() {
      counts.registrations++
      return { async prepare() { counts.preparations++; return { async invoke() { counts.bodies++; return 'completed' as const } } },
        cancel() {}, async cleanup() { entered.resolve(undefined); await gate.promise; counts.cleanups++ } }
    },
  })
  const owner = caller.ctx.get('fusionParticipants')!
  const enrollVia = declaring.ctx.get('fusionParticipants')!
  const task = await owner.prepare('top')
  const hostless = await owner.prepare('single-test')
  const ungranted = await owner.prepare('single-test')
  const resident = await task.adopt('executor')
  const sender = await task.adopt('userFacingLead')
  const handles: AgentHandle[] = [resident, sender]
  const host = await enrollVia.registerExecutionHost(task, provider('matrix-held'))
  const spare = await enrollVia.registerExecutionHost(ungranted, provider('matrix-grant'))
  const late = provider('matrix-late')
  const run = host.bindRun(host.issuer, resident.agent, new AbortController().signal)
  const unregistered = host.reserve(run, 'inspect'), registered = host.reserve(run, 'inspect')
  await host.register(registered)
  if (teardown === 'restart-late') removeObserver = observe()
  const observeState = (): Observation => ({
    delivery: task.delivery.snapshot(), attempts: task.execution.attempts.map(row => row.attemptId),
    grant: { generation: ungranted.execution.generation, owner: ungranted.execution.owner },
    enrolled: !hostless.execution.blockers.includes('integration-missing'),
  })
  const baseline = observeState()
  const probes: { label: string; sync: string[]; outcomes: Promise<string>[]; after: Observation }[] = []
  const settle = (operation: Promise<unknown>) => operation.then(() => 'accepted', (_refusal: unknown) => 'refused')
  const runProbe = (label: string): void => {
    const sync: string[] = []
    for (const operation of [() => host.bindRun(host.issuer, resident.agent, new AbortController().signal), () => host.reserve(run, 'inspect')]) {
      try { operation(); sync.push('accepted') } catch (_refusal: unknown) { sync.push('refused') }
    }
    const text = { inboxTarget: 'next-turn' as const, correlationId: null, text: 'input after the cutoff', targetParticipantId: resident.agent.id }
    const outcomes = [
      settle(host.register(unregistered)),
      host.release(registered).then(settlement => settlement.kind === 'settled' ? settlement.outcome : 'blocked', (_refusal: unknown) => 'refused'),
      settle(task.delivery.admitUser({ ...text, deliveryId: DeliveryId(`${label}-user`) })),
      settle(task.delivery.admitPeer(sender.agent, { ...text, deliveryId: DeliveryId(`${label}-peer`) })),
      settle(task.delivery.reconcile()),
      task.adopt('otherCoLead').then((handle) => { handles.push(handle); return 'accepted' }, (_refusal: unknown) => 'refused'),
      // Sibling tasks share the caller, host and service lifetimes but not another task's execution owner.
      ...lifetime === 'execution-owner' ? [] : [
        settle(spare.grant(spare.controller, ungranted.roster.roles.participant!)),
        settle(enrollVia.registerExecutionHost(hostless, late)),
      ],
    ]
    probes.push({ label, sync, outcomes, after: observeState() })
  }
  probe = () => { runProbe('edge') }
  let stopping: Promise<void> | undefined
  try {
    stopping = lifetime === 'execution-owner' ? host.dispose()
      : teardown === 'dispose-held' ? scope?.dispose() ?? service.dispose()
        : watched!.restart()
    if (lifetime === 'execution-owner') runProbe('edge')
    if (teardown === 'dispose-held') {
      await entered.promise
      runProbe('window')
      gate.resolve(undefined)
    }
    await stopping
    probe = undefined
    expect(probes.map(row => row.label)).toEqual(teardown === 'dispose-held' ? ['edge', 'window'] : ['edge'])
    const expected = ['refused', 'not-dispatched', 'refused', 'refused', 'refused', 'refused',
      ...lifetime === 'execution-owner' ? [] : ['refused', 'refused']]
    for (const row of probes) {
      expect({ label: row.label, sync: row.sync, outcomes: await Promise.all(row.outcomes) })
        .toEqual({ label: row.label, sync: ['refused', 'refused'], outcomes: expected })
      expect(row.after.delivery).toEqual(baseline.delivery)
      expect(row.after.attempts.filter(id => !baseline.attempts.includes(id))).toEqual([])
    }
    expect({ grant: observeState().grant, enrolled: observeState().enrolled }).toEqual({ grant: baseline.grant, enrolled: false })
    expect(counts).toEqual({ registrations: 1, preparations: 0, bodies: 0, cleanups: 1 })
    for (const id of [task.roster.rootSessionId, resident.agent.id, sender.agent.id]) {
      expect((await read(ctx, id)).filter(event => event.type.startsWith('fusion/delivery-')
        || event.type === 'agent/inbox/spliced' && event.data.inserted.length > 0)).toEqual([])
    }
    expect(adapter.requests).toHaveLength(0)
  } finally {
    probe = undefined
    removeObserver?.()
    gate.resolve(undefined)
    await Promise.allSettled([stopping])
    for (const handle of handles) await handle.dispose()
    await host.dispose(); await spare.dispose()
    for (const prepared of [task, hostless, ungranted]) await prepared.dispose()
    await declaring.dispose(); await hostParent?.dispose(); await caller.dispose(); await callerParent?.dispose()
  }
})
