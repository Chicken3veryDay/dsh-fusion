/** Executor guidance retains the prompt section interpolation policy. */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { expect, it } from 'vitest'
import Tools from '../src/index.ts'

it.each([undefined, false, true])('renders executor sections with interpolate=%s', async (interpolate) => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
    await ctx.plugin(Tools)
    ctx.systemPrompt.variable('value', () => 'resolved')
    ctx.tools.setExecutor({
      sections: [{ name: 'executor', order: 0, text: '{{value}}', ...interpolate === undefined ? {} : { interpolate } }],
      describe: () => ({ schemas: [], knownNames: [] }),
      execute: () => Promise.resolve({ results: [], additionalContexts: [], concluded: false }),
    })
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain(interpolate === false ? '{{value}}' : 'resolved')
  } finally {
    await ctx.fiber.dispose()
  }
})
