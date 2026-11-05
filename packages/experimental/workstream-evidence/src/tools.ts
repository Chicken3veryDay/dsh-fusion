/** Model tools for Workstream Evidence publication and verified reads. */
import { Context, Service } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkstreamEvidenceArtifactId, WorkstreamEvidenceOperationId } from './ids.ts'

function caller(agent: Agent | undefined): Agent {
  if (agent === undefined) throw new Error('Workstream evidence tools require a live calling Agent')
  return agent
}

const output = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown): [{ type: 'text'; text: string }] => [
    { type: 'text', text: JSON.stringify(value) },
  ],
}

const root = { type: 'string' as const, required: true as const, description: 'Stable Workstream root Session id.' }
const operation = { type: 'string' as const, required: true as const, description: 'Stable operation id for idempotent execution.' }
const artifact = { type: 'string' as const, required: true as const, description: 'Logical artifact identifier.' }

/** Opt-in Workstream Evidence tool registration with reversible Cordis ownership. */
export class WorkstreamEvidenceTools extends Service {
  static inject = ['tools', 'workstreamEvidence']
  constructor(ctx: Context) { super(ctx, 'workstreamEvidenceTools') }

  protected [Service.init](): void {
    const register = (tool: Parameters<Context['tools']['register']>[0]): void => { this.ctx.tools.register(tool) }

    register(defineTool({
      name: 'workstream_evidence_publish',
      description: 'Publish an immutable evidence version. Content is saved verbatim and retained permanently.',
      parameters: {
        root_session_id: root,
        operation_id: operation,
        artifact_id: artifact,
        expected_version: { type: 'integer' as const, required: true as const, description: 'Expected version number (1 for new).' },
        text: { type: 'string' as const, required: true as const, description: 'Evidence text content to store.' },
        name: { type: 'string' as const, description: 'Optional display filename.' },
      },
      output,
      execute: async (args, exec) => z.json().parse(
        await this.ctx.workstreamEvidence.publish(caller(exec.agent), SessionId(args.root_session_id), {
          operationId: WorkstreamEvidenceOperationId(args.operation_id),
          artifactId: WorkstreamEvidenceArtifactId(args.artifact_id),
          name: args.name,
          expectedVersion: args.expected_version,
          content: args.text,
          signal: exec.signal,
        }),
      ),
    }))

    register(defineTool({
      name: 'workstream_evidence_list',
      description: 'List all retained evidence artifacts and their version histories in the Workstream.',
      parameters: {
        root_session_id: root,
      },
      output,
      execute: (args, exec) => Promise.resolve(z.json().parse(
        this.ctx.workstreamEvidence.list(caller(exec.agent), SessionId(args.root_session_id)),
      )),
    }))

    register(defineTool({
      name: 'workstream_evidence_read',
      description: 'Read the verified UTF-8 text of an immutable evidence version. Fails for binary or oversized versions.',
      parameters: {
        root_session_id: root,
        artifact_id: artifact,
        version: { type: 'integer' as const, description: 'Version number to read (defaults to latest).' },
      },
      output,
      execute: async (args, exec) => {
        const result = await this.ctx.workstreamEvidence.readText(
          caller(exec.agent),
          SessionId(args.root_session_id),
          args.artifact_id,
          args.version,
          exec.signal,
        )
        return z.json().parse(result)
      },
    }))

    register(defineTool({
      name: 'workstream_evidence_aggregate_prs',
      description: 'Aggregate and deduplicate change request bindings across all Workstream member sessions.',
      parameters: {
        root_session_id: root,
      },
      output,
      execute: (args, exec) => Promise.resolve(z.json().parse(
        this.ctx.workstreamEvidence.aggregateChangeRequests(caller(exec.agent), SessionId(args.root_session_id)),
      )),
    }))
  }
}
