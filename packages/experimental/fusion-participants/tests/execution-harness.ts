/** Internal fake host integration over real retained Sessions and the actual tool pipeline. */
import { randomUUID } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, vi } from 'vitest'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import { TaskExecutionOwner } from '../src/execution.ts'
import { executionProjection } from '../src/execution-state.ts'
import { mount } from './harness.ts'

export function gate() { return { entered: Promise.withResolvers<undefined>(), resume: Promise.withResolvers<undefined>() } }
export async function fixture() {
  const { ctx, adapter: model, root: directory } = await mount()
  const projection = await ctx.sessionProjections.register({ ...executionProjection, key: 'fusionExecutionTest' })
  const handles: SessionHandle[] = []
  const create = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
  vi.spyOn(ctx.sessionPersistence, 'create').mockImplementation(async (...args) => {
    const handle = await create(...args); handles.push(handle); return handle
  })
  const root = await ctx.agents.retain({ sessionId: SessionId(randomUUID()), mode: 'create', agentOptions: {} })
  const child = await ctx.agents.retain({ sessionId: SessionId(randomUUID()), mode: 'create', root, agentOptions: {} })
  const adopted = await child.adopt()
  const agent = adopted.agent
  const issuer = Object.freeze({})
  const control = {
    bodies: 0, cleanups: 0, classification: 'mutation' as 'read' | 'mutation' | 'infrastructure' | undefined,
    wrapper: undefined as ReturnType<typeof gate> | undefined,
    body: undefined as ReturnType<typeof gate> | undefined,
    cleanup: undefined as ReturnType<typeof gate> | undefined,
    policy: true,
    onClassify: undefined as (() => void) | undefined,
  }
  const remove = ctx.tools.register(defineTool({
    name: 'authority_effect', description: 'Fake in-memory effect.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() {
      control.bodies++
      control.body?.entered.resolve(undefined)
      await control.body?.resume.promise
      return 'counted'
    },
  }))
  const abort = new AbortController()
  const owner = new TaskExecutionOwner({ ctx, root: root.session, participants: new Map([[child.session.id, child.session]]),
    signal: abort.signal, drain: () => Promise.resolve(undefined),
    state: new Map([root.session, child.session].map(session => [session, projection.readerFor(session)])),
    adapters: [{ issuer, name: 'fake-host', revision: 'fake-1', classify: () => { control.onClassify?.(); return control.classification },
      async prepare() {
        // Deliberately ignore cancellation requests: only the final fence authorizes this fake body.
        const signal = new AbortController().signal
        let finalFence: (() => Error | undefined) | undefined
        const pipeline = new ToolExecutionPipeline(ctx, { reject: () => control.policy ? finalFence?.() : new Error('policy revoked') })
        const tools = await ctx.tools.resolve({ agent, signal, modelSelection: { provider: 'omniroute-openai', model: 'fake' } })
        const prepared = await pipeline.prepare({ name: 'authority_effect', arguments: {}, agent, toolSet: tools,
          callId: ToolCallId('authority-effect'), signal })
        if (prepared.kind !== 'dispatch') { tools.dispose(); throw new Error('fake preparation refused') }
        return {
          async run(fence) {
            finalFence = fence
            control.wrapper?.entered.resolve(undefined)
            await control.wrapper?.resume.promise
            const result = await pipeline.complete(prepared.exec, await pipeline.dispatch(prepared.exec))
            return result.isError ? 'failed' : 'completed'
          },
          async cleanup() {
            control.cleanup?.entered.resolve(undefined)
            await control.cleanup?.resume.promise
            tools.dispose()
            control.cleanups++
          },
        }
      },
    }],
  })
  await owner.open()
  const controller = owner.controllerCapability()
  const grant = () => owner.grant(controller, child.session.id)
  const bind = () => owner.bindRun(issuer, agent, new AbortController().signal)
  const dispose = async () => {
    control.wrapper?.resume.resolve(undefined); control.body?.resume.resolve(undefined); control.cleanup?.resume.resolve(undefined)
    await owner.dispose()
    await adopted.dispose(); await child.dispose(); await root.dispose(); remove()
    expect(model.requests).toHaveLength(0)
  }
  return { ctx, root, child, agent, model, control, owner, issuer, controller, projection,
    grant, bind, dispose, handles, directory }
}
