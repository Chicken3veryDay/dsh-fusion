/** Model-facing tool bindings used by keyless profile adapters. */
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

/**
 * Read the current program SDK's declarations, or native schemas for a native scope.
 * @param options - Actual model request emitted by the composed profile.
 * @returns Names the model can invoke through the selected executor.
 */
export function modelToolNames(options: GenerateOptions): string[] {
  if (!options.tools?.some(tool => tool.name === 'run_code')) return (options.tools ?? []).map(tool => tool.name)
  const args = modelToolsSdk(options).split('\n}\n\ninterface ToolOutputMap')[0]!
  return [...args.matchAll(/^  ("(?:\\.|[^"\\])*"|[\w$]+):/gm)]
    .map(match => match[1]!.startsWith('"') ? String(JSON.parse(match[1]!)) : match[1]!)
}

/**
 * Select the advertised transport while keeping one logical tool operation per model step.
 * @param options - Actual model request emitted by the composed profile.
 * @param name - Logical tool operation, including intentionally denied probes.
 * @param args - Its JSON arguments.
 * @returns Model call name and serialized arguments.
 */
export function modelToolCall(options: GenerateOptions, name: string, args: object): { name: string; arguments: string } {
  return options.tools?.some(tool => tool.name === 'run_code')
    ? { name: 'run_code', arguments: JSON.stringify({ code: `return await tools[${JSON.stringify(name)}](${JSON.stringify(args)})`, description: `Call ${name}` }) }
    : { name, arguments: JSON.stringify(args) }
}

/**
 * Capture the current generated SDK declarations, including argument and return types.
 * @param options - Actual model request emitted by the composed profile.
 * @returns The final SDK declaration block present in its system messages.
 */
export function modelToolsSdk(options: GenerateOptions): string {
  const system = options.messages.filter(message => message.role === 'system')
    .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
  const start = system.lastIndexOf('interface ToolArgsMap {')
  if (start < 0) throw new Error('run_code request has no generated ToolArgsMap')
  return system.slice(start).split('\n```')[0]!
}
