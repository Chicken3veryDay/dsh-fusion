/**
 * Loader entry that mounts the default background curator. The context map package exports
 * `DefaultContextCurator` by name, and the Loader mounts only a module's default export.
 * @module @deepseek-ai/dsh-experimental-context-profile/context-curator
 */

export { DefaultContextCurator as default } from '@deepseek-ai/dsh-experimental-context-map'
