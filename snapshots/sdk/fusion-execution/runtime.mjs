/** Reconstruct required histories through the production dormant owner without executable adapters. */
export const name = 'snapshot-fusion-execution'
export const inject = ['commands', 'fusionParticipants', 'sessionPersistence', 'llm']
export function apply(ctx) {
  let claims = 0, requests = 0
  ctx.on('agent/inbox/claimed', () => { claims++ })
  ctx.on('agent/request', () => { requests++; throw new Error('Execution fixture forbids model requests') })
  ctx.on('llm/stream', () => { throw new Error('Execution fixture forbids provider dispatch') })
  ctx.effect(() => ctx.commands.register({
    name: 'execution_fixture', definitionId: 'snapshot/execution-fixture', description: 'Recover closed task authority',
    async handler() {
      const task = await ctx.fusionParticipants.recover('execution-root')
      try {
        const facts = task.execution
        const parked = await task.adopt('participant')
        await parked.agent.whenIdle()
        const reader = await ctx.sessionPersistence.open('execution-child', 'read')
        let events
        try { events = (await reader.read()).events } finally { await reader.close() }
        const callbacks = Object.values(facts).filter(value => typeof value === 'function').length
        if (facts.phase !== 'closed' || facts.owner !== null || callbacks !== 0 || claims !== 0 || requests !== 0) {
          throw new Error('Recovered history enabled task execution')
        }
        return { kind: 'success', text: JSON.stringify({ closed: facts.phase === 'closed' && facts.owner === null,
          frozen: Object.isFrozen(facts) && Object.isFrozen(facts.attempts), callbacks,
          attempts: facts.attempts.length, unknown: facts.unknown.length, blockers: facts.blockers,
          claims, requests, queued: parked.agent.inbox.nextTurn.length,
          starts: events.filter(row => row.type === 'fusion/effect-started').length,
          producerSettlements: events.filter(row => row.type === 'fusion/effect-settled').length,
          reconciliations: events.filter(row => row.type === 'fusion/effect-reconciled').length, oldGeneration: facts.generation,
        }) }
      } finally { await task.dispose() }
    },
  }))
}
