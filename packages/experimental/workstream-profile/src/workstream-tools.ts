/**
 * Loader entry that mounts `workstream_*` tools. The Workstream package exports `WorkstreamTools`
 * by name, and the Loader mounts only a module's default export.
 * @module @deepseek-ai/dsh-experimental-workstream-profile/workstream-tools
 */

export { WorkstreamTools as default } from '@deepseek-ai/dsh-experimental-workstream'
