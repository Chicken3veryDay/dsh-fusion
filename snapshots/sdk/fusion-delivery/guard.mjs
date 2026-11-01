/** Refuse inference independently of Fusion imports and prove the dispatch guard is active. */
export const name = 'snapshot-fusion-delivery-guard'
export const inject = ['llm']
export function apply(ctx) {
  let dispatches = 0
  const message = 'Delivery fixture forbids provider dispatch'
  ctx.on('llm/stream', () => { dispatches++; throw new Error(message) })
  // The real public dispatch seam must reach this guard before adapter lookup or credentials.
  let controlled = false
  try { ctx.llm.stream({ provider: 'delivery-negative-control', model: 'none' }) }
  catch (error) { controlled = error.message === message }
  if (!controlled || dispatches !== 1) throw new Error('Delivery provider guard is inactive')
  dispatches = 0
  ctx.on('agent/request', () => { throw new Error('Delivery fixture forbids inference') })
  ctx.provide('deliveryFixtureGuard', { assertDormant() {
    if (dispatches !== 0) throw new Error('Delivery attempted provider dispatch')
  } })
}
