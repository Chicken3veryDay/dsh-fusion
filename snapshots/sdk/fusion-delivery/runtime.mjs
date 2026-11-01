/** Dormant Fusion fixture over retained writers; no inference or guest tool is installed. */
export const name = 'snapshot-fusion-delivery'
export const inject = ['commands', 'agents', 'fusionParticipants', 'sessionPersistence']

export function apply(ctx) {
  let claims = 0
  let requests = 0
  ctx.on('agent/inbox/claimed', () => { claims++ })
  ctx.on('agent/request', () => { requests++; throw new Error('Unauthorized delivery model request') })
  ctx.effect(() => ctx.commands.register({
    name: 'delivery_fixture', definitionId: 'snapshot/delivery-fixture',
    description: 'Reconcile recorded dormant Fusion text',
    handler: async () => {
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
        const state = task.delivery.snapshot()
        return { kind: 'success', text: JSON.stringify({ revision: state.decisionInputRevision,
          unclassified: state.classificationPending.length, queued: parked.agent.inbox.nextTurn.length,
          claims, requests, logicalInstructions: instructions.length,
          source: instructions[0].data.inserted[0].source, messageId: first.messageId }) }
      } finally { await task.dispose() }
    },
  }))
}
