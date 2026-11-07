/** Dependency closure reads committed implementations and tolerates a lifetime that retains none. */
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { dependencyClosure } from '../src/liveness.ts'

it('keeps a disposed lifetime and its ancestors after its committed implementations are released', async () => {
  const ctx = new Context()
  const scope = createScope(ctx, {})
  await scope.dispose()
  expect(scope.ctx.fiber.committed).toBeUndefined()
  expect([...dependencyClosure(scope.ctx.fiber)]).toEqual([scope.ctx.fiber, ctx.fiber])
})
