/**
 * Loader entry that mounts `context_note` and the curator tools. The context map package exports
 * `ContextMapTools` by name, and the Loader mounts only a module's default export.
 * @module @deepseek-ai/dsh-experimental-context-profile/context-map-tools
 */

export { ContextMapTools as default } from '@deepseek-ai/dsh-experimental-context-map'
