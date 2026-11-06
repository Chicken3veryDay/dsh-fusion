/** Model tools `context_browse` and `context_load`, registered as one reversible group. */
import { Context, Service } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { renderBrowse, renderLoad } from './render.ts'
import type { ContextBrowseResult, ContextLoadResult } from './types.ts'
import { ContextTreeError } from './error.ts'

function caller(agent: Agent | undefined): Agent {
  if (agent === undefined) throw new ContextTreeError('context tree tools require a live calling Agent', 'CONTEXT_TREE_INVALID_INPUT')
  return agent
}

/** Opt-in registration of `context_browse` and `context_load`. */
export class ContextTreeTools extends Service {
  static inject = ['tools', 'contextTree']
  constructor(ctx: Context) { super(ctx, 'contextTreeTools') }

  protected [Service.init](): void {
    this.ctx.tools.register(defineTool({
      name: 'context_browse',
      description:
        'List the context tree: instructions, reference documents, and extra tools you can load on demand. '
        + 'Returns each node\'s path, title, and one line saying when to use it, never its body. '
        + 'Start with no path, then narrow; raise depth to see more levels at once (capped).',
      parameters: {
        path: { type: 'string', description: 'Node to list, as printed by an earlier listing. Omit for the top.' },
        depth: { type: 'integer', description: 'Levels to list below the node. Default 1.' },
        offset: { type: 'integer', description: 'Entries to skip, to continue a listing that said more remain. Default 0.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: renderBrowse(z.custom<ContextBrowseResult>().parse(value)) }],
      },
      execute: async (args, exec) => {
        const result = await this.ctx.contextTree.browse(caller(exec.agent), {
          ...args.path === undefined ? {} : { path: args.path },
          ...args.depth === undefined ? {} : { depth: args.depth },
          ...args.offset === undefined ? {} : { offset: args.offset },
        }, exec.signal)
        return z.json().parse(result)
      },
    }), { origin: 'global' })
    this.ctx.tools.register(defineTool({
      name: 'context_load',
      description:
        'Load nodes from the context tree. An instruction or source node adds its text to the conversation; '
        + 'a tool node makes those tools callable from your next step. Several paths in one call count as one change. '
        + 'Loaded text and tools are dropped when the conversation is compacted.',
      parameters: {
        paths: { type: 'array', required: true, items: { type: 'string' }, description: 'Node paths from context_browse. A folder loads everything under it.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: renderLoad(z.custom<ContextLoadResult>().parse(value)) }],
      },
      execute: async (args, exec) => {
        const outcome = await this.ctx.contextTree.load(caller(exec.agent), { paths: args.paths }, exec.signal)
        for (const context of outcome.contexts) exec.deferContext(context)
        return z.json().parse(outcome.result)
      },
    }), { origin: 'global' })
  }
}

export default ContextTreeTools
