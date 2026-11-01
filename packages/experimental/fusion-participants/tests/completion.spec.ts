/** Remaining delivery evidence uses exact Agents and real retained writers. */
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it, vi } from 'vitest'
import { JsonlSessionHandle } from '../../../session/session-persistence-jsonl/src/storage.ts'
import { DeliveryId } from '../src/index.ts'
import { mount, read, message } from './harness.ts'

afterEach(() => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
})

it('rejects foreign exact Agents and stale object identities before reserving, and rejects changed routing and content', async () => {
  const { ctx } = await mount()
  const task = await ctx.fusionParticipants.prepare('top')
  const peer = await task.adopt('userFacingLead')
  const foreignTask = await ctx.fusionParticipants.prepare('top')
  const foreign = await foreignTask.adopt('userFacingLead')
  const input = { deliveryId: DeliveryId('exact-identity'), targetParticipantId: task.roster.roles.executor!,
    inboxTarget: 'next-turn' as const, correlationId: null, text: 'original\r\n𝄞' }
  await expect(task.delivery.admitPeer(new Proxy(peer.agent, {}), input)).rejects.toThrow()
  await expect(task.delivery.admitPeer(foreign.agent, input)).rejects.toThrow()
  expect(task.delivery.snapshot().decisionInputRevision).toBe(0)
  const receipt = await task.delivery.admitPeer(peer.agent, input)
  for (const variant of [
    { ...input, inboxTarget: 'next-step' as const },
    { ...input, correlationId: 'different' },
    { ...input, targetParticipantId: task.roster.roles.userFacingLead! },
    { ...input, text: 'original\n𝄞' },
    { ...input, text: 'original\r\nchanged' },
  ]) await expect(task.delivery.admitPeer(peer.agent, variant)).rejects.toThrow()
  await expect(task.delivery.admitUser(input)).rejects.toThrow()
  await peer.dispose()
  const replacement = await task.adopt('userFacingLead')
  expect(replacement.agent).not.toBe(peer.agent)
  await expect(task.delivery.admitPeer(peer.agent, input)).rejects.toThrow()
  expect(await task.delivery.admitPeer(replacement.agent, input)).toEqual(receipt)
  expect(task.delivery.snapshot().decisionInputRevision).toBe(1)
  await foreignTask.dispose()
  await task.dispose()
})

it.each(['root', 'receiver', 'completion'] as const)('waits for the actual %s writer flush, blocks on uncertainty and recovers the same revision', async (phase) => {
  const { ctx, root: directory } = await mount()
  const task = await ctx.fusionParticipants.prepare('single-test')
  const root = ctx.sessions.get(task.roster.rootSessionId)!
  const target = ctx.sessions.get(task.roster.roles.participant!)!
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted writer as this.
  const original = JsonlSessionHandle.prototype.flush
  let held = false
  const spy = vi.spyOn(JsonlSessionHandle.prototype, 'flush').mockImplementation(async function (this: JsonlSessionHandle) {
    const completion = root.snapshotEvents().some(row => row.type === 'fusion/delivery-completed')
    if (!held && this.access === 'write' && this.id === (phase === 'receiver' ? target.id : root.id)
      && (phase === 'completion' ? completion : !completion)) {
      held = true
      entered.resolve(undefined)
      await release.promise
      throw new Error('uncertain actual writer flush')
    }
    return original.call(this)
  })
  const input = { deliveryId: DeliveryId(`uncertain-${phase}`), targetParticipantId: target.id,
    inboxTarget: 'next-turn' as const, correlationId: null, text: 'same revision' }
  let receipt = false
  const admission = task.delivery.admitUser(input).then((value) => { receipt = true; return value })
  const rejected = expect(admission).rejects.toThrow()
  await entered.promise
  expect(receipt).toBe(false)
  expect(target.snapshotEvents().filter(row => row.type === 'fusion/delivery-accepted')).toHaveLength(phase === 'root' ? 0 : 1)
  expect(root.snapshotEvents().filter(row => row.type === 'fusion/delivery-completed')).toHaveLength(phase === 'completion' ? 1 : 0)
  release.resolve(undefined)
  await rejected
  spy.mockRestore()
  expect(task.delivery.snapshot()).toMatchObject({ decisionInputRevision: 1, classificationPending: [input.deliveryId] })
  await task.delivery.reconcile()
  const first = await task.delivery.admitUser(input)
  expect(first.decisionInputRevision).toBe(1)
  await task.dispose()
  const second = await mount(directory)
  const recovered = await second.ctx.fusionParticipants.recover(root.id)
  expect(await recovered.delivery.admitUser(input)).toEqual(first)
  await recovered.dispose()
})

it.each(['root', 'receiver', 'completion'] as const)('refuses real retained writer and route loss at %s and recovers the same assignment', async (phase) => {
  const { ctx, root: directory } = await mount()
  const task = await ctx.fusionParticipants.prepare('single-test')
  const root = ctx.sessions.get(task.roster.rootSessionId)!
  const target = ctx.sessions.get(task.roster.roles.participant!)!
  // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted writer as this.
  const original = JsonlSessionHandle.prototype.flush
  let closed = false
  const spy = vi.spyOn(JsonlSessionHandle.prototype, 'flush').mockImplementation(async function (this: JsonlSessionHandle) {
    const completion = root.snapshotEvents().some(row => row.type === 'fusion/delivery-completed')
    if (!closed && this.access === 'write' && this.id === (phase === 'receiver' ? target.id : root.id)
      && (phase === 'completion' ? completion : !completion)) {
      closed = true
      await this.close()
    }
    return original.call(this)
  })
  const input = { deliveryId: DeliveryId(`lost-${phase}`), targetParticipantId: target.id,
    inboxTarget: 'next-turn' as const, correlationId: null, text: 'writer loss' }
  await expect(task.delivery.admitUser(input)).rejects.toThrow()
  expect(closed).toBe(true)
  expect(target.snapshotEvents().filter(row => row.type === 'fusion/delivery-accepted')).toHaveLength(phase === 'root' ? 0 : 1)
  expect(root.snapshotEvents().filter(row => row.type === 'fusion/delivery-completed')).toHaveLength(phase === 'completion' ? 1 : 0)
  spy.mockRestore()
  await task.dispose()
  const restarted = await mount(directory)
  const recovered = await restarted.ctx.fusionParticipants.recover(root.id)
  expect(await recovered.delivery.admitUser(input)).toMatchObject({ decisionInputRevision: 1 })
  expect((await read(restarted.ctx, target.id)).filter(row => row.type === 'fusion/delivery-accepted')).toHaveLength(1)
  await recovered.dispose()
})

it('observes active native, process, job, claim and provider seams across success, failure and recovery without dispatch', async () => {
  const { NativeToolExecutor } = await import('@deepseek-ai/dsh-tool-executor-native')
  const { default: Jobs } = await import('../../../jobs/jobs-local/src/index.ts')
  const { default: childProcess } = await import('node:child_process')
  const { ToolCallId } = await import('@deepseek-ai/dsh-llm')
  const { defineContentToolFixture } = await import('../../../test-support/tool-testkit/src/index.ts')
  const { ctx, adapter, root: directory } = await mount()
  await ctx.plugin(Jobs, {})
  const native = vi.spyOn(NativeToolExecutor.prototype, 'execute')
  const jobs = vi.spyOn(ctx.jobs, 'start')
  const spawn = vi.spyOn(childProcess, 'spawn')
  const launches = [spawn, ...(['spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const)
    .map(method => vi.spyOn(childProcess, method))]
  syncBuiltinESMExports()
  const provider = vi.spyOn(adapter, 'stream')
  const claim = vi.fn()
  ctx.on('agent/inbox/claimed', claim)
  // Seed real service paths before the dormant interval; a zero on an absent service is insufficient.
  const tool = vi.fn(async () => [])
  const removeTool = ctx.tools.register(defineContentToolFixture({ name: 'dormancy_control', description: 'Observer control', parameters: {}, execute: tool }))
  await ctx.tools.execute({ calls: [{ type: 'tool-call', id: ToolCallId('control'), name: 'dormancy_control', arguments: '{}' }], signal: new AbortController().signal })
  expect(tool).toHaveBeenCalledTimes(1)
  removeTool()
  const child = childProcess.spawn(process.execPath, ['-e', ''], { stdio: 'ignore', env: {} })
  await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => { if (code === 0) resolve(); else reject(new Error(`control exit ${code}`)) }) })
  expect(childProcess.spawnSync(process.execPath, ['-e', ''], { env: {} }).status).toBe(0)
  childProcess.execFileSync(process.execPath, ['-e', ''], { env: {} })
  const command = `"${process.execPath}" -e ""`
  childProcess.execSync(command, { env: {} })
  await new Promise<void>((resolve, reject) => {
    childProcess.exec(command, { env: {} }, (error) => { if (error instanceof Error) reject(error); else resolve() })
  })
  await new Promise<void>((resolve, reject) => { childProcess.execFile(process.execPath, ['-e', ''], { env: {} }, (error) => { if (error instanceof Error) reject(error); else resolve() }) })
  const controlPath = join(directory, 'launch-control.cjs')
  await writeFile(controlPath, '')
  const fork = childProcess.fork(controlPath, [], { env: {}, stdio: 'ignore' })
  await new Promise<void>((resolve, reject) => { fork.once('error', reject); fork.once('exit', (code) => { if (code === 0) resolve(); else reject(new Error(`fork control exit ${code}`)) }) })
  for (const observer of launches) expect(observer).toHaveBeenCalled()
  ctx.jobs.attachController('dormancy instrumentation control')
  const job = ctx.jobs.start({ kind: 'bash', label: 'dormancy instrumentation control',
    run: () => ({ cancel() {}, done: Promise.resolve({ status: 'completed' }) }) })
  await ctx.jobs.wait(job, 1000)
  const controlAgent = await ctx.agents.create({ sessionId: SessionId('dispatch-control'), agentOptions: { provider: 'omniroute-openai', model: 'gpt-6.1-sol' } })
  controlAgent.agent.followup(message('seed fake provider and claim observers'))
  await controlAgent.agent.whenIdle()
  expect(native).toHaveBeenCalledTimes(1)
  expect(spawn).toHaveBeenCalled()
  expect(jobs).toHaveBeenCalledTimes(1)
  expect(provider).toHaveBeenCalled()
  expect(claim).toHaveBeenCalled()
  await controlAgent.dispose()
  for (const observer of [native, ...launches, jobs, provider, claim]) observer.mockClear()
  const task = await ctx.fusionParticipants.prepare('single-test')
  const input = { deliveryId: DeliveryId('dispatch-observers'), targetParticipantId: task.roster.roles.participant!,
    inboxTarget: 'next-turn' as const, correlationId: null, text: 'dormant dispatch evidence' }
  const receipt = await task.delivery.admitUser(input)
  const uncertain = { ...input, deliveryId: DeliveryId('dispatch-observers-uncertain') }
  const barrier = vi.spyOn(ctx.sessionPersistence, 'flushSessionDurably').mockResolvedValueOnce({ kind: 'refused', reason: 'coverage' })
  await expect(task.delivery.admitUser(uncertain)).rejects.toThrow()
  barrier.mockRestore()
  await task.delivery.reconcile()
  expect((await task.delivery.admitUser(uncertain)).decisionInputRevision).toBe(2)
  await expect(task.delivery.admitUser({ ...input, text: 'conflict' })).rejects.toThrow()
  const parked = await task.adopt('participant')
  parked.agent.followup(message('parked followup'))
  parked.agent.cancel({ kind: 'user' })
  await parked.agent.whenIdle()
  await task.dispose()
  const restarted = await mount(directory)
  await restarted.ctx.plugin(Jobs, {})
  const restartedJobs = vi.spyOn(restarted.ctx.jobs, 'start')
  const restartedProvider = vi.spyOn(restarted.adapter, 'stream')
  restarted.ctx.on('agent/inbox/claimed', claim)
  const recovered = await restarted.ctx.fusionParticipants.recover(task.roster.rootSessionId)
  expect(await recovered.delivery.admitUser(input)).toEqual(receipt)
  const again = await recovered.adopt('participant')
  await again.agent.whenIdle()
  await recovered.dispose()
  for (const observer of [native, ...launches, jobs, provider, claim, restartedJobs, restartedProvider]) {
    expect(observer).not.toHaveBeenCalled()
  }
  for (const observer of launches) observer.mockRestore()
  syncBuiltinESMExports()
})
