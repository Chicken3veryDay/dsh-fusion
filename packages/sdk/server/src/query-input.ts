/** Desktop text-input recognition for the SDK; command execution stays with the native registry. */

import type { CommandDescriptor, CommandDefinitionId } from '@deepseek-ai/dsh-commands'
import { builtinCommandName, resolveCommand } from '@deepseek-ai/dsh-commands/builtin'

/**
 * Recognize compact, explicit permission changes, plan, and goal by their definition identities.
 * Canonical and Chinese aliases follow the effective registered name; unrelated exact names remain prompts.
 * Explicit additional definition ids admit their registered exact names. Other text remains a prompt.
 * @param text - original input; the caller preserves it on the ordinary-prompt path.
 * @param commands - exact receiving Agent's current command descriptors.
 * @param additionalDefinitions - deployment opt-in by exact definition identity, never a display-name allowlist.
 * @returns the supported command line using its registered name and a native-compatible separator, otherwise undefined.
 */
export function queryCommand(
  text: string, commands: readonly CommandDescriptor[], additionalDefinitions: readonly CommandDefinitionId[] = [],
): string | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return undefined
  const separator = trimmed.search(/\s/u)
  const name = separator === -1 ? trimmed.slice(1) : trimmed.slice(1, separator)
  const descriptor = resolveCommand(name, commands)
  if (descriptor === undefined) return undefined
  const builtin = builtinCommandName(descriptor)
  const rawInput = separator === -1 ? '' : trimmed.slice(separator).replace(/^[^\S \t\r\n]/u, ' ')
  if (descriptor.definitionId !== undefined && additionalDefinitions.includes(descriptor.definitionId)) return `/${descriptor.name}${rawInput}`
  if (builtin === 'compact' && separator === -1) return `/${descriptor.name}`
  if (builtin === 'permission' && separator !== -1) return `/${descriptor.name}${rawInput}`
  if (builtin === 'plan' || builtin === 'goal') return `/${descriptor.name}${rawInput}`
  return undefined
}
