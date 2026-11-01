/** Refuse controller inference even when a dependent fixture fails to mount. */
export const name = 'snapshot-fusion-delivery-guard'
export function apply(ctx) {
  ctx.on('agent/request', () => { throw new Error('Delivery fixture forbids inference') })
}
