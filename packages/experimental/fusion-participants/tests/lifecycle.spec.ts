import { DeliveryId } from '../src/index.ts'
/** Loader composition, real JSONL restart and parked Agent context lineage. */
import { expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { scanLog, sessionDir } from '../../../session/session-persistence-jsonl/src/format.ts'
import { ReactLoopAgent } from '../../../core/agent-loop/src/agent.ts'

import { mount, read, message, roots } from './harness.ts'

it('captures Top role links, holds root first, re-adopts exact writers and restores queued input without claims', async () => {
  const { ctx, root, adapter } = await mount()
  const creates: SessionId[] = []
  const create = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
  vi.spyOn(ctx.sessionPersistence, 'create').mockImplementation(async (header, options) => { creates.push(header.id); return create(header, options) })
  const claims = vi.fn()
  ctx.on('agent/inbox/claimed', claims)
  const task = await ctx.fusionParticipants.prepare('top')
  const roster = task.roster
  expect(roster.participants).toHaveLength(3)
  expect(roster.roles.decider).toBe(roster.roles.userFacingLead)
  expect(roster.roles.takeover).toBe(roster.roles.userFacingLead)
  expect(roster.roles.userFacingLead).not.toBe(roster.roles.otherCoLead)
  expect(creates).toEqual([roster.rootSessionId, ...roster.participants.map(row => row.id)])
  expect(adapter.requests).toHaveLength(0)
  expect(claims).not.toHaveBeenCalled()
  const rootEvents = await read(ctx, roster.rootSessionId)
  expect(rootEvents.filter(event => event.type === 'fusion/participant-established')).toHaveLength(3)
  const one = await task.adopt('userFacingLead')
  const proof = await ctx.sessionPersistence.flushSessionDurably(one.agent.session)
  one.agent.followup(message('first'))
  await one.agent.whenIdle()
  expect(claims).not.toHaveBeenCalled()
  expect(adapter.requests).toHaveLength(0)
  await one.dispose()
  const two = await task.adopt('decider')
  expect(two.agent.session).toBe(one.agent.session)
  expect(two.agent.inbox.nextTurn).toHaveLength(1)
  const after = await ctx.sessionPersistence.flushSessionDurably(two.agent.session)
  expect(after).toMatchObject({ kind: 'durable', ...proof.kind === 'durable' ? { writer: proof.writer } : {} })
  await task.dispose()
  const second = await mount(root)
  const opens: SessionId[] = []
  const open = second.ctx.sessionPersistence.open.bind(second.ctx.sessionPersistence)
  vi.spyOn(second.ctx.sessionPersistence, 'open').mockImplementation(async (id, access, options) => { if (access === 'write') opens.push(id); return open(id, access, options) })
  const recovered = await second.ctx.fusionParticipants.recover(roster.rootSessionId)
  expect(recovered.roster).toEqual(roster)
  expect(opens).toEqual([roster.rootSessionId, ...roster.participants.map(row => row.id)])
  const three = await recovered.adopt('userFacingLead')
  expect(three.agent.inbox.nextTurn).toHaveLength(1)
  three.agent.steer(message('second'))
  await three.agent.whenIdle()
  expect(second.adapter.requests).toHaveLength(0)
  await expect(second.ctx.agents.resume({ resumeSessionId: three.agent.id })).rejects.toThrow()
  await recovered.dispose()
})

it('keeps a single participant and actually reuses fake model context after detach and restart', async () => {
  const { ctx, root, adapter } = await mount()
  const task = await ctx.fusionParticipants.prepare('single-test')
  expect(task.roster.participants).toHaveLength(1)
  const first = await task.adopt('participant')
  if (!(first.agent instanceof ReactLoopAgent)) throw new Error('expected production driver')
  const errors: unknown[] = []
  ctx.on('agent/error', ({ error }) => { errors.push(error) })
  await first.agent.testOnlyTurn(message('remember alpha'))
  expect(errors).toEqual([])
  expect(adapter.requests).toHaveLength(1)
  await first.dispose()
  const second = await task.adopt('decider')
  if (!(second.agent instanceof ReactLoopAgent)) throw new Error('expected production driver')
  await second.agent.testOnlyTurn(message('remember beta'))
  expect(adapter.requests).toHaveLength(2)
  expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('remember alpha')
  expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('retained answer')
  const rootId = task.roster.rootSessionId
  await task.dispose()
  const restarted = await mount(root)
  const recovered = await restarted.ctx.fusionParticipants.recover(rootId)
  const third = await recovered.adopt('participant')
  if (!(third.agent instanceof ReactLoopAgent)) throw new Error('expected production driver')
  await third.agent.testOnlyTurn(message('recall both'))
  expect(restarted.adapter.requests).toHaveLength(1)
  expect(JSON.stringify(restarted.adapter.requests[0]?.messages)).toContain('remember alpha')
  expect(JSON.stringify(restarted.adapter.requests[0]?.messages)).toContain('remember beta')
  await recovered.dispose()
})

it('fails closed on held root and participant leases, without replacing IDs or claiming work', async () => {
  const { ctx, root, adapter } = await mount()
  const task = await ctx.fusionParticipants.prepare('top')
  const roster = task.roster
  const second = await mount(root)
  await expect(second.ctx.fusionParticipants.recover(roster.rootSessionId)).rejects.toThrow()
  await task.dispose()
  const held = await ctx.sessionPersistence.open(roster.participants[1]!.id, 'write')
  await expect(second.ctx.fusionParticipants.recover(roster.rootSessionId)).rejects.toThrow()
  expect(second.ctx.sessions.list()).toHaveLength(0)
  expect(adapter.requests).toHaveLength(0)
  expect(second.adapter.requests).toHaveLength(0)
  await held.close()
  const recovered = await second.ctx.fusionParticipants.recover(roster.rootSessionId)
  expect(recovered.roster).toEqual(roster)
  await recovered.dispose()
})

it('keeps partial provisioning recoverable and never replaces an established missing participant', async () => {
  const { ctx, root, adapter } = await mount()
  const stat = ctx.sessionPersistence.stat.bind(ctx.sessionPersistence)
  let rootId: SessionId | undefined
  const create = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
  let count = 0
  vi.spyOn(ctx.sessionPersistence, 'create').mockImplementation(async (...args) => {
    if (++count === 1) rootId = args[0].id
    if (count === 3) throw new Error('participant acquisition failed')
    return create(...args)
  })
  await expect(ctx.fusionParticipants.prepare('top')).rejects.toMatchObject({ code: 'fusion-participants/preparation-blocked', cleanup: 'complete' })
  expect(rootId).toBeDefined()
  expect(ctx.sessions.list()).toHaveLength(0)
  vi.restoreAllMocks()
  const recovered = await ctx.fusionParticipants.recover(rootId!)
  const roster = recovered.roster
  await recovered.dispose()
  vi.spyOn(ctx.sessionPersistence, 'stat').mockImplementation(async (id, options) => id === roster.participants[0]!.id ? undefined : stat(id, options))
  await expect(ctx.fusionParticipants.recover(rootId!)).rejects.toMatchObject({ rootSessionId: rootId, cleanup: 'complete' })
  expect(ctx.sessions.list()).toHaveLength(0)
  expect(adapter.requests).toHaveLength(0)
  const restarted = await mount(root)
  const task = await restarted.ctx.fusionParticipants.recover(rootId!)
  expect(task.roster).toEqual(roster)
  await task.dispose()
})

it('refuses failed barriers, stale task capabilities and unknown roles without admitting input', async () => {
  const { ctx, adapter } = await mount()
  vi.spyOn(ctx.sessionPersistence, 'flushSessionDurably').mockResolvedValue({ kind: 'refused', reason: 'flush-failed', cause: new Error('injected flush failure') })
  await expect(ctx.fusionParticipants.prepare('top')).rejects.toMatchObject({ cleanup: 'complete' })
  vi.restoreAllMocks()
  const task = await ctx.fusionParticipants.prepare('single-test')
  await expect(task.adopt('unknown')).rejects.toThrow('not owned')
  await task.dispose()
  await expect(task.adopt('participant')).rejects.toThrow('not owned')
  expect(adapter.requests).toHaveLength(0)
})

it('awaits cancellation during root acquisition and leaves no live routes', async () => {
  const { ctx } = await mount()
  const abort = new AbortController()
  const create = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
  vi.spyOn(ctx.sessionPersistence, 'create').mockImplementation(async (...args) => {
    const writer = await create(...args)
    abort.abort(new Error('stop preparing'))
    return writer
  })
  await expect(ctx.fusionParticipants.prepare('top', abort.signal)).rejects.toMatchObject({ cleanup: 'complete' })
  expect(ctx.sessions.list()).toHaveLength(0)
  expect(ctx.agents.list()).toHaveLength(0)
})

it('validates immutable restored membership and preserves separately selected decider contexts', async () => {
  const { captureRoster, rosterSchema } = await import('../src/roster.ts')
  const { ctx } = await mount()
  const selection = ctx.fusionConfig.selection('middle')
  const digest = 'a'.repeat(64)
  const roster = captureRoster(selection, digest)
  expect(roster.tier).toBe('middle')
  expect(roster.upgrades).toEqual(selection.upgrades)
  const separate = captureRoster({ ...selection, authority: { ...selection.authority, decider: 'decider' } }, digest)
  expect(separate.roles.decider).not.toBe(separate.roles.lead)
  expect(() => captureRoster({ ...selection, roles: {} }, digest)).toThrow('decider')
  expect(() => captureRoster({ ...selection, authority: { decider: 'decider', takeover: 'otherCoLead' } }, digest)).toThrow('takeover')
  expect(rosterSchema.safeParse({ ...roster, roles: {} }).success).toBe(false)
  expect(rosterSchema.safeParse({ ...roster, mode: 'single' }).success).toBe(false)
  const top = captureRoster(ctx.fusionConfig.selection('top'), digest)
  expect(rosterSchema.safeParse({ ...top, roles: { ...top.roles, otherCoLead: top.roles.userFacingLead } }).success).toBe(false)
  expect(rosterSchema.safeParse({ ...top, participants: [...top.participants].reverse() }).success).toBe(false)
  const single = captureRoster(ctx.fusionConfig.selection('single-test'), digest)
  expect(rosterSchema.safeParse({ ...single, participants: [...single.participants, ...single.participants] }).success).toBe(false)
  expect(Object.isFrozen(single)).toBe(true)
})

it('refuses malformed or duplicate required lifecycle records during real restart', async () => {
  const { ctx } = await mount()
  const { rosterProjection } = await import('../src/state.ts')
  const task = await ctx.fusionParticipants.prepare('single-test')
  const roster = task.roster
  const session = ctx.sessions.get(roster.rootSessionId)!
  session.append('fusion/roster', roster)
  await task.dispose()
  await expect(ctx.fusionParticipants.recover(roster.rootSessionId)).rejects.toMatchObject({ cleanup: 'complete' })
  const other = await ctx.fusionParticipants.prepare('single-test')
  const root = ctx.sessions.get(other.roster.rootSessionId)!
  root.append('fusion/participant-established', { participantId: SessionId('foreign') })
  await other.dispose()
  await expect(ctx.fusionParticipants.recover(other.roster.rootSessionId)).rejects.toMatchObject({ cleanup: 'complete' })
  expect(rosterProjection.init()).toEqual({ roster: null, established: [] })
})

it('refuses a root without a roster, composition replacement, and service disposal with a parked resident', async () => {
  const { ctx } = await mount()
  const rootId = SessionId('no-roster')
  const root = await ctx.agents.retain({ sessionId: rootId, mode: 'create', agentOptions: {} })
  await root.dispose()
  await expect(ctx.fusionParticipants.recover(rootId)).rejects.toMatchObject({ cleanup: 'complete' })
  const task = await ctx.fusionParticipants.prepare('single-test')
  const id = task.roster.rootSessionId
  await task.dispose()
  const read = ctx.agentPresets.readDocument.bind(ctx.agentPresets)
  vi.spyOn(ctx.agentPresets, 'readDocument').mockImplementation(async preset => ({ ...await read(preset), content: 'changed' }))
  await expect(ctx.fusionParticipants.recover(id)).rejects.toMatchObject({ cleanup: 'complete' })
  vi.restoreAllMocks()
  const recovered = await ctx.fusionParticipants.recover(id)
  const resident = await recovered.adopt('participant')
  await ctx.fiber.dispose()
  expect(resident.agent.status).toBe('idle')
  await expect(recovered.adopt('participant')).rejects.toThrow()
})

it('refuses successful task cleanup after a retained descendant rejects, before any claims or requests', async () => {
  const { ctx, adapter } = await mount()
  const claims = vi.fn()
  ctx.on('agent/inbox/claimed', claims)
  const task = await ctx.fusionParticipants.prepare('single-test')
  const handle = await task.adopt('participant')
  handle.agent.followup(message('must stay parked'))
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  let peerCleaned = false
  const nested = await handle.agent.ctx.plugin((owner) => {
    owner.effect(() => async () => { entered.resolve(undefined); await release.promise; throw new Error('retained nested cleanup unknown') })
    owner.effect(() => () => { peerCleaned = true })
  })
  const raw = nested.dispose()
  await entered.promise
  const cleanup = task.dispose()
  let finished = false
  const observed = cleanup.finally(() => { finished = true })
  const refused = expect(observed).rejects.toThrow('participant task cleanup failed')
  await Promise.resolve()
  expect(finished).toBe(false)
  expect(peerCleaned).toBe(true)
  release.resolve(undefined)
  await raw
  await refused
  await expect(task.dispose()).rejects.toThrow('participant task cleanup failed')
  await expect(task.adopt('participant')).rejects.toThrow('not owned')
  expect(ctx.agents.list()).toHaveLength(0)
  expect(ctx.sessions.list()).toHaveLength(0)
  for (const id of [task.roster.rootSessionId, ...task.roster.participants.map(row => row.id)]) {
    const writer = await ctx.sessionPersistence.open(id, 'write')
    await writer.close()
  }
  const independent = await ctx.fusionParticipants.prepare('single-test')
  const next = await independent.adopt('participant')
  await next.dispose()
  await independent.dispose()
  expect(adapter.requests).toHaveLength(0)
  expect(claims).not.toHaveBeenCalled()
})

it('reports unknown preparation rollback when a real composition effect rejects cleanup', async () => {
  const { ctx, adapter } = await mount()
  const mountPreset = ctx.agentPresets.mount.bind(ctx.agentPresets)
  let mounts = 0
  vi.spyOn(ctx.agentPresets, 'mount').mockImplementation(async (owner, preset) => {
    const mounted = await mountPreset(owner, preset)
    if (++mounts === 2) {
      owner.effect(() => () => { throw new Error('composition cleanup failed') })
      throw new Error('witness setup failed')
    }
    return mounted
  })
  await expect(ctx.fusionParticipants.prepare('single-test')).rejects.toMatchObject({ cleanup: 'unknown' })
  expect(ctx.sessions.list()).toHaveLength(0)
  expect(ctx.agents.list()).toHaveLength(0)
  expect(adapter.requests).toHaveLength(0)
})

it('refuses re-adoption after nested plugin setup and rollback fail in the Loader task', async () => {
  const { ctx, adapter } = await mount()
  const task = await ctx.fusionParticipants.prepare('single-test')
  const claims = vi.fn()
  ctx.on('agent/inbox/claimed', claims)
  ctx.on('agent/created', async ({ agent }) => {
    agent.followup(message('queued during failed setup'))
    await agent.ctx.plugin(async function* () {
      yield () => { throw new Error('nested rollback unknown') }
      await Promise.resolve()
      throw new Error('nested setup rejected')
    })
  })
  await expect(task.adopt('participant')).rejects.toThrow('initialization and cleanup failed')
  expect(ctx.agents.list()).toHaveLength(0)
  expect(ctx.sessions.list().length).toBeGreaterThan(0)
  await expect(task.adopt('participant')).rejects.toThrow('cleanup remains unknown')
  await expect(task.dispose()).rejects.toThrow('participant task cleanup failed')
  expect(ctx.sessions.list()).toHaveLength(0)
  expect(adapter.requests).toHaveLength(0)
  expect(claims).not.toHaveBeenCalled()
})

it('reports unknown witness cleanup even when composition mounting succeeds', async () => {
  const { ctx, adapter } = await mount()
  const mountPreset = ctx.agentPresets.mount.bind(ctx.agentPresets)
  let mounts = 0
  vi.spyOn(ctx.agentPresets, 'mount').mockImplementation(async (owner, preset) => {
    const mounted = await mountPreset(owner, preset)
    if (++mounts === 2) owner.effect(() => () => { throw new Error('witness cleanup unknown') })
    return mounted
  })
  await expect(ctx.fusionParticipants.prepare('single-test')).rejects.toMatchObject({ cleanup: 'unknown' })
  expect(ctx.sessions.list()).toHaveLength(0)
  expect(adapter.requests).toHaveLength(0)
})

it('refuses a roster barrier after the retained root barrier succeeded', async () => {
  const { ctx, adapter } = await mount()
  const flush = ctx.sessionPersistence.flushSessionDurably.bind(ctx.sessionPersistence)
  let calls = 0
  vi.spyOn(ctx.sessionPersistence, 'flushSessionDurably').mockImplementation(async (session) => {
    if (++calls === 2) return { kind: 'refused', reason: 'flush-failed', cause: new Error('roster flush failed') }
    return flush(session)
  })
  await expect(ctx.fusionParticipants.prepare('single-test')).rejects.toMatchObject({
    cleanup: 'complete', cause: { message: 'participant durability refused: flush-failed' },
  })
  expect(calls).toBe(2)
  expect(ctx.sessions.list()).toHaveLength(0)
  expect(ctx.agents.list()).toHaveLength(0)
  expect(adapter.requests).toHaveLength(0)
})

it('reads stock upstream records and safely refuses each managed record with the preserved upstream JSONL parser', async () => {
  const upstreamTree = 'd3c6ee1d1f0ec8b71c92e1b62d0cf9a8d6553bf8'
  const preserved = (path: string): string => execFileSync('git', ['show', `${upstreamTree}:${path}`], { encoding: 'utf8' })
  const parserPath = 'packages/session/session-persistence-jsonl/src/format.ts'
  const parser = preserved(parserPath)
  expect(await readFile(parserPath, 'utf8')).toBe(parser)
  const scratch = await mkdtemp(join(process.cwd(), 'packages/session/session-persistence-jsonl/tests', '.p03-upstream-parser-'))
  roots.push(scratch)
  await writeFile(join(scratch, 'known.ts'), preserved('packages/core/session/src/known-event-types.ts'))
  await writeFile(join(scratch, 'parser.ts'), parser.replace('  KNOWN_SESSION_EVENT_TYPES,\n', '')
    + '\nexport { KNOWN_SESSION_EVENT_TYPES } from \'./known.ts\'\n')
  // Only the installed vocabulary changes: the preserved physical parser and released codecs are unchanged.
  await writeFile(join(scratch, 'parser.ts'), (await readFile(join(scratch, 'parser.ts'), 'utf8'))
    .replace('import { isAbsolute', "import { KNOWN_SESSION_EVENT_TYPES } from './known.ts'\nimport { isAbsolute"))
  const validationPath = 'packages/session/session-persistence/src/storage-contract.ts'
  const validation = preserved(validationPath)
  expect(await readFile(validationPath, 'utf8')).toBe(validation)
  await writeFile(join(scratch, 'storage-contract.ts'), validation
    .replace('  KNOWN_SESSION_EVENT_TYPES,\n', '')
    .replace("from './errors.ts'", "from '@deepseek-ai/dsh-session-persistence'")
    + "\nimport { KNOWN_SESSION_EVENT_TYPES } from './known.ts'\n")
  const oldValidation = await import(/* @vite-ignore */ pathToFileURL(join(scratch, 'storage-contract.ts')).href) as typeof import('../../../session/session-persistence/src/storage-contract.ts')
  const old = await import(/* @vite-ignore */ pathToFileURL(join(scratch, 'parser.ts')).href) as typeof import('../../../session/session-persistence-jsonl/src/format.ts')
  const { ctx, root } = await mount()
  const stock = await ctx.agents.create({ sessionId: SessionId('upstream-stock'), agentOptions: { provider: 'omniroute-openai', model: 'gpt-6.1-sol' } })
  await ctx.sessionPersistence.flushSessionDurably(stock.agent.session)
  const stockCwd = stock.agent.session.header.cwd
  await stock.dispose()
  const stockBytes = await readFile(join(sessionDir(root, stockCwd, SessionId('upstream-stock')), 'session.v4.jsonl'))
  const oldStock = old.scanLog(stockBytes)
  const oldWritten = Buffer.from(`${JSON.stringify(old.toHeaderLine(oldStock.meta))}\n${old.eventLines(oldStock.events)}\n`)
  expect(scanLog(oldWritten)).toMatchObject({ meta: oldStock.meta, events: oldStock.events })
  expect(scanLog(stockBytes)).toEqual(oldStock)
  expect(oldValidation.validateStoredEvents(oldStock.meta, oldStock.events)).toEqual(oldStock.events)
  const resumed = await ctx.agents.resume({ resumeSessionId: SessionId('upstream-stock') })
  await resumed.dispose()
  const task = await ctx.fusionParticipants.prepare('single-test')
  const rootId = task.roster.rootSessionId
  await task.delivery.admitUser({ deliveryId: DeliveryId('old-reader'), targetParticipantId: task.roster.roles.participant!,
    inboxTarget: 'next-turn', correlationId: null, text: 'required delivery' })
  const receiverBytes = await readFile(join(sessionDir(root, undefined, task.roster.roles.participant!), 'session.v4.jsonl'))
  await task.dispose()
  const bytes = await readFile(join(sessionDir(root, undefined, rootId), 'session.v4.jsonl'))
  const rows = bytes.toString('utf8').trim().split('\n')
  const current = scanLog(bytes)
  expect(current.events.filter(event => ['agent/runtime-owner', 'fusion/roster', 'fusion/participant-established'].includes(event.type))).toHaveLength(3)
  const deliveryRows = [...rows, ...receiverBytes.toString('utf8').trim().split('\n')]
  for (const type of ['agent/runtime-owner', 'fusion/roster', 'fusion/participant-established',
    'fusion/delivery-intent', 'fusion/delivery-accepted', 'fusion/delivery-completed', 'fusion/execution-opened']) {
    const row = deliveryRows.find(line => (JSON.parse(line) as { type: string }).type === type)
    expect(row).toBeDefined()
    if (row === undefined) throw new Error(`missing managed record ${type}`)
    const event = JSON.parse(row) as object
    const isolated = Buffer.from(`${rows[0]}\n${JSON.stringify({ ...event, seq: 0 })}\n`)
    const parsed = old.scanLog(isolated)
    expect(() => oldValidation.validateStoredEvents(parsed.meta, parsed.events)).toThrow(`event type "${type}"`)
  }
  for (const type of ['fusion/execution-granted', 'fusion/execution-revoked',
    'fusion/effect-started', 'fusion/effect-settled', 'fusion/effect-reconciled']) {
    const isolated = Buffer.from(`${rows[0]}\n${JSON.stringify({ type, seq: 0, time: 1, data: {} })}\n`)
    const parsed = old.scanLog(isolated)
    expect(() => oldValidation.validateStoredEvents(parsed.meta, parsed.events)).toThrow(`event type "${type}"`)
  }
  const parsed = old.scanLog(bytes)
  expect(() => oldValidation.validateStoredEvents(parsed.meta, parsed.events)).toThrow('agent/runtime-owner')
})

it.each(['missing-owner', 'malformed-owner', 'duplicate-owner', 'missing-roster', 'malformed-roster',
  'duplicate-roster', 'malformed-established', 'duplicate-established'])(
  'refuses managed activation after durable %s corruption', async (corruption) => {
    const { ctx, root, adapter } = await mount()
    const task = await ctx.fusionParticipants.prepare('single-test')
    const id = task.roster.rootSessionId
    await task.dispose()
    const path = join(sessionDir(root, undefined, id), 'session.v4.jsonl')
    const rows = (await readFile(path, 'utf8')).trim().split('\n')
    const type = corruption.endsWith('owner') ? 'agent/runtime-owner'
      : corruption.endsWith('roster') ? 'fusion/roster' : 'fusion/participant-established'
    const index = rows.findIndex(line => (JSON.parse(line) as { type: string }).type === type)
    expect(index).toBeGreaterThan(0)
    const selected = rows[index]
    if (selected === undefined) throw new Error(`missing corruption target ${type}`)
    if (corruption.startsWith('missing')) rows.splice(index, 1)
    else if (corruption.startsWith('duplicate')) rows.splice(index, 0, selected)
    else {
      const row = JSON.parse(selected) as object
      rows[index] = JSON.stringify({ ...row, data: {} })
    }
    const resequenced = rows.map((line, index) => {
      const row = JSON.parse(line) as object
      return JSON.stringify(index === 0 ? row : { ...row, seq: index - 1 })
    })
    await writeFile(path, resequenced.join('\n') + '\n')
    const restarted = await mount(root)
    const claims = vi.fn()
    restarted.ctx.on('agent/inbox/claimed', claims)
    await expect(restarted.ctx.fusionParticipants.recover(id)).rejects.toMatchObject({ cleanup: 'complete' })
    expect(adapter.requests).toHaveLength(0)
    expect(restarted.adapter.requests).toHaveLength(0)
    expect(claims).not.toHaveBeenCalled()
    expect(restarted.ctx.agents.list()).toHaveLength(0)
    expect(restarted.ctx.sessions.list()).toHaveLength(0)
  },
)
