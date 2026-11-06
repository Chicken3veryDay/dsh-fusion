/** Final-history validation checks a retained selection without publishing or replacing it. */
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool, orderedAdmission } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it } from 'vitest'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

async function harness() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const loop = await mountAgentLoopTestHarness(ctx)
  const agent = await loop.create(SessionId('admission-validation'), { provider: 'test', model: 'test' })
  const controller = new AbortController()
  const input = { agent, modelSelection: { provider: 'test', model: 'test' }, signal: controller.signal }
  const definition = defineTool({
    name: 'probe', description: 'Test operation.', parameters: {},
    output: { schema: { type: 'boolean' }, render: () => [{ type: 'text', text: 'done' }] },
    execute: async () => true,
  })
  return { ctx, agent, input, controller, definition }
}

it.each(['stable', 'condition', 'policy', 'order', 'disposed', 'removed', 'replaced'] as const)(
  'validates %s admission without substituting a selection', async (path) => {
    const h = await harness()
    let changed = false
    const registration = h.ctx.tools.register(h.definition, { when: () => !(changed && path === 'condition') })
    h.ctx.tools.registerAdmissionPolicy(({ candidates }) => changed && path === 'policy'
      ? [] : changed && path === 'order' ? orderedAdmission(candidates.keys()) : candidates.keys())
    const selected = await h.ctx.tools.resolve(h.input)
    changed = true
    if (path === 'disposed') selected.dispose()
    if (path === 'removed' || path === 'replaced') registration()
    if (path === 'replaced') h.ctx.tools.register(h.definition)
    try {
      if (path === 'stable') {
        await expect(selected.validate()).resolves.toBeUndefined()
        expect([...selected.view(h.agent).values()]).toEqual([h.definition])
      } else {
        await expect(selected.validate()).rejects.toMatchObject({ code: 'TOOL_ADMISSION_FAILED' })
      }
    } finally { selected.dispose() }
  },
)

it.each(['condition', 'policy', 'cancel', 'late-removal'] as const)(
  'preserves failure and cancellation when validation encounters %s', async (path) => {
    const h = await harness()
    let changed = false
    const cancellation = new Error('cancel validation')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const registration = h.ctx.tools.register(h.definition, { when: async () => {
      if (changed && path === 'condition') throw new Error('condition unavailable')
      if (changed && path === 'late-removal') { entered.resolve(undefined); await release.promise }
      return true
    } })
    h.ctx.tools.registerAdmissionPolicy(({ candidates }) => {
      if (changed && path === 'cancel') h.controller.abort(cancellation)
      if (changed && path === 'policy') throw new Error('policy unavailable')
      return candidates.keys()
    })
    const selected = await h.ctx.tools.resolve(h.input)
    changed = true
    const checking = selected.validate()
    const assertion = path === 'cancel'
      ? expect(checking).rejects.toBe(cancellation)
      : expect(checking).rejects.toMatchObject({ code: path === 'condition' ? 'TOOL_ACTIVATION_FAILED' : 'TOOL_ADMISSION_FAILED' })
    try {
      if (path === 'late-removal') { await entered.promise; registration(); release.resolve(undefined) }
      await assertion
    } finally { release.resolve(undefined); selected.dispose() }
  },
)


it.each(['added', 'removed', 'replaced'] as const)('ignores an %s unadmitted registration while retaining admitted identities', async (path) => {
  const h = await harness()
  h.ctx.tools.register(h.definition)
  const hidden = { ...h.definition, name: 'unadmitted' }
  const registration = path === 'added' ? undefined : h.ctx.tools.register(hidden, { when: () => false })
  const selected = await h.ctx.tools.resolve(h.input)
  try {
    registration?.()
    if (path !== 'removed') h.ctx.tools.register(hidden)
    await expect(selected.validate()).resolves.toBeUndefined()
    expect([...selected.view(h.agent).values()]).toEqual([h.definition])
    expect(h.ctx.tools.executable('unadmitted', h.agent, selected)).toBeUndefined()
    expect(h.ctx.tools.executable('probe', h.agent, selected)).toBe(h.definition)
  } finally { selected.dispose() }
})
