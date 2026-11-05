/**
 * Loader entry that mounts `workstream_evidence_*` tools. The Workstream Evidence package exports
 * `WorkstreamEvidenceTools` by name, and the Loader mounts only a module's default export.
 * @module @deepseek-ai/dsh-experimental-workstream-profile/workstream-evidence-tools
 */

export { WorkstreamEvidenceTools as default } from '@deepseek-ai/dsh-experimental-workstream-evidence'
