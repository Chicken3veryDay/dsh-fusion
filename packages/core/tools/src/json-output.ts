/** JSON tool output with compact model-facing text. */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/**
 * Declare an unrestricted JSON result rendered as one compact text block.
 * @returns A fresh output declaration for a JSON-valued tool.
 */
export function jsonToolOutput(): {
  schema: { type: 'json' }
  render: (args: unknown, value: JsonValue) => [{ type: 'text'; text: string }]
} {
  return {
    schema: { type: 'json' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}
