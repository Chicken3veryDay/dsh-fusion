/** Select one child evaluator without process-lifetime policy. */
import type { PtcProgramFormat } from '@deepseek-ai/dsh-ptc-runtime'
import { createAsyncFunctionEvaluator } from './async-function.ts'
import { createReplEvaluator } from './repl.ts'
import { createVmScriptEvaluator } from './vm-script.ts'
import type { EvaluatorDiagnostic, ProgramEvaluator } from './types.ts'

const evaluators: Record<PtcProgramFormat, (report: (diagnostic: EvaluatorDiagnostic) => void) => ProgramEvaluator> = {
  'function-body': createAsyncFunctionEvaluator,
  repl: createReplEvaluator,
  script: createVmScriptEvaluator,
}

/**
 * Create the selected evaluator for either a fresh or retained process.
 * @param format - Evaluation syntax selected by the host.
 * @param report - Asynchronous diagnostics, delivered in the async context of the evaluation that caused them.
 * @returns Globals, evaluation entry point, and resource cleanup.
 */
export function createProgramEvaluator(format: PtcProgramFormat, report: (diagnostic: EvaluatorDiagnostic) => void): ProgramEvaluator {
  return evaluators[format](report)
}
