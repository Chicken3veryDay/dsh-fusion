/** Registration changes preserve task admission without restarting their shared service providers. */
import { expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import Preset from '@deepseek-ai/dsh-agent-preset'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Participants, { DeliveryId } from '../src/index.ts'
import { dependencyClosure } from '../src/liveness.ts'
import { mount } from './harness.ts'

it('keeps delivery and held allocation available across preset, adapter, command and tool updates', async () => {
  const { ctx, adapter } = await mount()
  ctx.loader.builtins.reviewPi = PiAi
  ctx.loader.builtins.reviewContributions = {
    name: 'review-contributions', inject: ['commands', 'tools'],
    apply(child: Context) {
      child.commands.register({ name: 'review_reload', description: 'Review reload control',
        handler: () => ({ kind: 'success', text: 'ready' }) })
      child.tools.register(defineTool({ name: 'review_reload', description: 'Review reload control', parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: async () => 'ready' }))
    },
  }
  const profile = (baseURL: string) => ({ api: 'openai-completions', baseURL, models: [{ id: 'review-model' }] })
  const pi = ctx.loader.resolve(await ctx.loader.create({ name: 'cordis:reviewPi', config: { providers: { 'review-route': profile('http://127.0.0.1:1/v1') } } }))
  const contributions = ctx.loader.resolve(await ctx.loader.create({ name: 'cordis:reviewContributions' }))
  await ctx.loader.await()
  const owner = [...ctx.registry.get(Participants)!.fibers][0]!
  const closure = dependencyClosure(owner)
  expect(pi.fiber).toBeDefined()
  expect(contributions.fiber).toBeDefined()
  expect(closure.has(pi.fiber!)).toBe(false)
  expect(closure.has(contributions.fiber!)).toBe(false)
  const task = await ctx.fusionParticipants.prepare('single-test')
  const resident = await task.adopt('participant')
  let registrations = 0, cleanups = 0
  const host = await ctx.fusionParticipants.registerExecutionHost(task, {
    name: 'registration-reload', revision: '1', classify: () => 'read',
    registerHeld() {
      registrations++
      return { async prepare() { throw new Error('must not prepare') }, cancel() {}, async cleanup() { cleanups++ } }
    },
  })
  const preset = [...ctx.registry.get(Preset)!.fibers][0]!.entry!
  const piFiber = pi.fiber
  try {
    await preset.update({ config: { id: 'standard', name: 'Updated declaration', plugins: [] } })
    await ctx.loader.await()
    await task.delivery.admitUser({ deliveryId: DeliveryId('after-preset'), targetParticipantId: resident.agent.id,
      inboxTarget: 'next-turn', correlationId: null, text: 'after preset update' })
    await pi.update({ config: { providers: { 'review-route': profile('http://127.0.0.1:1/v2') } } })
    await ctx.loader.await()
    expect(pi.fiber).toBe(piFiber)
    await contributions.fiber!.restart()
    await ctx.loader.await()
    expect([...ctx.registry.get(Participants)!.fibers][0]).toBe(owner)
    await task.delivery.admitUser({ deliveryId: DeliveryId('after-registrations'), targetParticipantId: resident.agent.id,
      inboxTarget: 'next-turn', correlationId: null, text: 'after registration updates' })
    const attempt = host.reserve(host.bindRun(host.issuer, resident.agent, new AbortController().signal), 'inspect')
    await host.register(attempt)
    expect(registrations).toBe(1)
    expect(task.delivery.snapshot().decisionInputRevision).toBe(2)
    expect(adapter.requests).toHaveLength(0)
  } finally {
    await host.dispose(); await resident.dispose(); await task.dispose()
  }
  expect(cleanups).toBe(1)
})
