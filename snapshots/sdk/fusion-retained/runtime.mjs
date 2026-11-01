/** Host-only fixture control over real retained writers; no model or guest capability is installed. */
export const name = 'snapshot-fusion-retained'
export const inject = ['commands', 'agents', 'sessionPersistence', 'sessions']

export function apply(ctx) {
  let claims = 0
  let requests = 0
  ctx.on('agent/inbox/claimed', () => { claims++ })
  ctx.on('agent/request', () => { requests++; throw new Error('Unauthorized fixture model request') })
  ctx.effect(() => ctx.commands.register({
    name: 'retained_fixture',
    definitionId: 'snapshot/retained-fixture',
    description: 'Exercise parked retained Session recovery',
    handler: async () => {
      const root = await ctx.agents.retain({ sessionId: 'retained-root', mode: 'resume', agentOptions: {} })
      let child
      try {
        child = await ctx.agents.retain({ sessionId: 'retained-child', root, mode: 'resume', agentOptions: {} })
        const before = await ctx.sessionPersistence.flushSessionDurably(child.session)
        const first = await child.adopt()
        const history = JSON.stringify(first.agent.session.deriveMessages())
        if (!history.includes('remember alpha')) throw new Error('Recorded history was lost')
        if (first.agent.inbox.nextTurn.length !== 1) throw new Error('Recorded queued input was claimed')
        first.agent.followup({ role: 'user', id: 'recorded-wakeup',
          content: [{ type: 'text', text: 'parked wakeup probe' }], source: { kind: 'user' } })
        await first.agent.whenIdle()
        if (first.agent.inbox.nextTurn.length !== 2 || claims !== 0 || requests !== 0) {
          throw new Error('Parked follow-up claimed recorded input')
        }
        first.agent.inbox.splice('next-turn', 1, 1, [])
        await first.dispose()
        const next = await child.adopt()
        if (next.agent.session !== child.session) throw new Error('Adoption replaced the retained Session')
        await next.agent.whenIdle()
        const after = await ctx.sessionPersistence.flushSessionDurably(next.agent.session)
        if (before.kind !== 'durable' || after.kind !== 'durable' || before.writer !== after.writer) {
          throw new Error('Adoption did not retain the same durable writer')
        }
        if (next.agent.inbox.nextTurn.length !== 1 || claims !== 0 || requests !== 0) {
          throw new Error('Parked recovery admitted unauthorized work')
        }
      } finally {
        await root.dispose()
      }
      let stockRefused = false
      try {
        const unauthorized = await ctx.agents.resume({ resumeSessionId: 'retained-child' })
        await unauthorized.dispose()
      } catch (error) { stockRefused = String(error).includes('retained runtime owner') }
      let wrongRootRefused = false
      try {
        const unauthorized = await ctx.agents.retain({ sessionId: 'retained-child', mode: 'resume', agentOptions: {} })
        await unauthorized.dispose()
      } catch (error) { wrongRootRefused = String(error).includes('ownership') }
      if (!stockRefused || !wrongRootRefused) throw new Error('Invalid ownership was not visibly refused')
      return { kind: 'success', text: JSON.stringify({
        history: 'remember alpha', queued: 1, sameSession: true, sameWriter: true,
        claims, requests, stockRefused, wrongRootRefused,
      }) }
    },
  }))
}
