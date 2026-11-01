/** Dormant Fusion fixture over retained writers; no inference or guest tool is installed. */
export const name = 'snapshot-fusion-delivery'
export const inject = ['commands', 'agents', 'fusionParticipants', 'sessionPersistence', 'deliveryFixtureGuard', 'sessions']

export function apply(ctx) {
  let claims = 0
  let requests = 0
  ctx.on('agent/inbox/claimed', () => { claims++ })
  ctx.on('agent/request', () => { requests++; throw new Error('Unauthorized delivery model request') })
  for (const phase of ['root', 'receiver', 'completion']) ctx.effect(() => ctx.commands.register({
    name: `delivery_shutdown_${phase}`, definitionId: `snapshot/delivery-shutdown-${phase}`,
    description: 'Hold dormant delivery through raw root teardown',
    handler: () => shutdownFixture(ctx, phase),
  }))
  ctx.effect(() => ctx.commands.register({
    name: 'delivery_fixture', definitionId: 'snapshot/delivery-fixture',
    description: 'Reconcile recorded dormant Fusion text',
    handler: async () => {
      ctx.deliveryFixtureGuard.assertDormant()
      let task
      try { task = await ctx.fusionParticipants.recover('delivery-root') }
      catch (error) { throw new Error(JSON.stringify(error, ['message', 'cause', 'errors'])) }
      try {
        const input = { deliveryId: 'recorded-delivery-id', targetParticipantId: 'delivery-child',
          inboxTarget: 'next-turn', correlationId: null, text: 'ok\r\nretained delivery' }
        const first = await task.delivery.admitUser(input)
        const retry = await task.delivery.admitUser(input)
        if (JSON.stringify(first) !== JSON.stringify(retry)) throw new Error('Retry changed the receipt')
        const parked = await task.adopt('participant')
        if (parked.agent.inbox.nextTurn.length > 0) parked.agent.inbox.splice('next-turn', 0, 1, [])
        await parked.agent.whenIdle()
        const reader = await ctx.sessionPersistence.open('delivery-child', 'read')
        let events
        try { events = (await reader.read()).events } finally { await reader.close() }
        const accepted = events.filter(row => row.type === 'fusion/delivery-accepted')
        const instructions = events.filter(row => row.type === 'agent/inbox/spliced' && row.data.inserted.length > 0)
        if (accepted.length !== 1 || instructions.length !== 1 || requests !== 0 || claims !== 0) {
          throw new Error('Delivery replay duplicated input or started work')
        }
        ctx.deliveryFixtureGuard.assertDormant()
        const state = task.delivery.snapshot()
        return { kind: 'success', text: JSON.stringify({ revision: state.decisionInputRevision,
          unclassified: state.classificationPending.length, queued: parked.agent.inbox.nextTurn.length,
          claims, requests, logicalInstructions: instructions.length,
          source: instructions[0].data.inserted[0].source, messageId: first.messageId }) }
      } finally { await task.dispose() }
    },
  }))
}

/** The SDK acknowledges setup before its client triggers raw application-root teardown. */
async function shutdownFixture(ctx, phase) {
  const { watch } = await import('node:fs')
  const { writeFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { setImmediate } = await import('node:timers/promises')
  const directory = process.env.DSH_FUSION_SHUTDOWN_CONTROL
  if (!directory) throw new Error('Missing shutdown fixture control directory')
  const guard = ctx.deliveryFixtureGuard
  const persistence = ctx.sessionPersistence
  const sessions = ctx.sessions
  const writers = new Map()
  const originalOpen = persistence.open
  persistence.open = async function (...args) {
    const writer = await originalOpen.apply(this, args)
    if (args[1] === 'write') writers.set(args[0], writer)
    return writer
  }
  let task
  try { task = await ctx.fusionParticipants.recover('delivery-root') }
  finally { persistence.open = originalOpen }
  const roster = JSON.stringify(task.roster)
  const root = sessions.get('delivery-root')
  const receiver = sessions.get('delivery-child')
  const proofs = await Promise.all([persistence.flushSessionDurably(root), persistence.flushSessionDurably(receiver)])
  const identities = proofs.map(proof => {
    if (proof.kind !== 'durable') throw new Error('Fixture did not acquire a durable writer')
    return proof.writer
  })
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const draining = Promise.withResolvers()
  const closes = []
  const saved = []
  let held = false
  let rootFlushes = 0
  let drainSettled = false
  let admissionSettled = false
  let rootSettled = false
  let receipt = false
  for (const [id, writer] of writers) {
    const flush = writer.flush
    const close = writer.close
    saved.push(() => { writer.flush = flush; writer.close = close })
    writer.flush = async function (...args) {
      if (id === 'delivery-root') rootFlushes++
      const selected = phase === 'receiver' ? id === 'delivery-child'
        : id === 'delivery-root' && rootFlushes === (phase === 'completion' ? 2 : 1)
      if (!held && selected) { held = true; entered.resolve(); await release.promise }
      return flush.apply(this, args)
    }
    writer.close = function (...args) { closes.push(id); return close.apply(this, args) }
  }
  const rawDrain = task.delivery.dispose
  task.delivery.dispose = function () {
    draining.resolve()
    return rawDrain.call(this).then(() => { drainSettled = true })
  }
  let started = false
  const watcher = watch(directory, (_event, filename) => {
    if (filename !== 'start' || started) return
    started = true
    watcher.close()
    void (async () => {
      const admission = task.delivery.admitUser({ deliveryId: 'recorded-delivery-id', targetParticipantId: 'delivery-child',
        inboxTarget: 'next-turn', correlationId: null, text: 'ok\r\nretained delivery' })
        .then(() => { receipt = true }, () => {}).finally(() => { admissionSettled = true })
      await entered.promise
      const stop = ctx.root.fiber.dispose().then(() => { rootSettled = true })
      await draining.promise
      await setImmediate()
      const before = { phase, closed: closes.length, admissionPending: !admissionSettled,
        drainPending: !drainSettled, rootPending: !rootSettled,
        routesRetained: sessions.get(root.id) === root && sessions.get(receiver.id) === receiver,
        exactWriters: [...writers.values()].every((writer, index) => writer.durabilityOpen && writer.durabilityIdentity === identities[index]) }
      try {
        if (before.closed !== 0 || !before.admissionPending || !before.drainPending || !before.rootPending
          || !before.routesRetained || !before.exactWriters) throw new Error(`Early resource release: ${JSON.stringify(before)}`)
        await sessions.flush(root)
        await sessions.flush(receiver)
        await writeFile(join(directory, 'before.json'), JSON.stringify(before))
      } finally { release.resolve() }
      await admission
      await stop
      for (const restore of saved) restore()
      guard.assertDormant()
      const result = { ...before, rootSettled, receipt, rosterUnchanged: JSON.stringify(task.roster) === roster,
        writersClosed: new Set(closes).size }
      await writeFile(join(directory, 'result.json'), JSON.stringify(result))
    })().catch(async error => {
      release.resolve()
      await writeFile(join(directory, 'error.json'), JSON.stringify(error, ['message', 'cause', 'errors']))
    })
  })
  return { kind: 'success', text: JSON.stringify({ phase, ready: true }) }
}
