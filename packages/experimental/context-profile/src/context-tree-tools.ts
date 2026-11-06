/**
 * Loader entry that mounts `context_browse` and `context_load`. The context tree package exports
 * `ContextTreeTools` by name, and the Loader mounts only a module's default export.
 * @module @deepseek-ai/dsh-experimental-context-profile/context-tree-tools
 */

export { ContextTreeTools as default } from '@deepseek-ai/dsh-experimental-context-tree'
