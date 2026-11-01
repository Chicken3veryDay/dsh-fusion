/** Prepare a symlink-free executable runtime payload with shared workspace module instances. */
import { cp, lstat, readFile, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dump, load } from 'js-yaml'

function isHoistedLocations(value: unknown): value is Record<string, string[]> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.values(value).every(paths => Array.isArray(paths)
      && paths.every((path: unknown) => typeof path === 'string'))
}

/**
 * Share root workspace packages with nested consumers of the same pnpm dependency identity.
 * Different peer resolutions and third-party packages keep their installed locations.
 * All metadata paths are checked before deletion; the caller first materializes links.
 * @param staging - Symlink-free deployed payload root.
 * @param workspace - Workspace root relative to which pnpm records hoisted locations.
 */
export async function deduplicateStagedWorkspacePackages(staging: string, workspace: string): Promise<void> {
  const modules = resolve(staging, 'node_modules')
  const file = join(modules, '.modules.yaml')
  const manifest: unknown = load(await readFile(file, 'utf8'))
  if (typeof manifest !== 'object' || manifest === null || !('hoistedLocations' in manifest)
    || !isHoistedLocations(manifest.hoistedLocations)) {
    throw new Error(`${file}: hoistedLocations must map dependency identities to path lists`)
  }
  const duplicates: string[] = []
  for (const [identity, locations] of Object.entries(manifest.hoistedLocations)) {
    const paths = locations.map((location) => {
      const path = resolve(workspace, location)
      const local = relative(modules, path)
      if (local === '' || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) {
        throw new Error(`${file}: hoistedLocations path is outside deployed node_modules: ${location}`)
      }
      return { path, parts: local.split(sep) }
    })
    if (!/^(?:@[^/]+\/)?[^@()]+@file:/.test(identity)) continue
    const root = paths.find(({ parts }) => parts.length === (parts[0]?.startsWith('@') === true ? 2 : 1))
    if (root === undefined) continue
    if (!(await lstat(root.path)).isDirectory()) {
      throw new Error(`${file}: hoistedLocations root package is not a directory: ${root.path}`)
    }
    duplicates.push(...paths.filter(({ path }) => path !== root.path).map(({ path }) => path))
  }
  for (const path of duplicates) await rm(path, { recursive: true, force: true })
}

/** Return the first symbolic link below a directory, if one exists. */
async function findSymlink(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = await findSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/**
 * Replace every deploy-time package link below the staged payload with real files.
 *
 * Legacy deploy links workspace packages into the target's `node_modules`, and
 * those links must survive packaging as files. One link is not a package: when
 * the deploy target sits inside the deployed project, pnpm links that project
 * into its own `node_modules`. Dereferencing it would copy the payload into
 * itself, and the packaged payload never carries the project source, so the
 * entry is dropped instead.
 * @param staging - Deployed payload root whose `node_modules` becomes symlink-free.
 */
export async function materializeStagedLinks(staging: string): Promise<void> {
  const payload = await realpath(staging)
  const nodeModules = join(staging, 'node_modules')
  let remaining = await findSymlink(nodeModules)
  while (remaining !== undefined) {
    const segments = remaining.slice(nodeModules.length + 1).split(sep)
    const binIndex = segments.lastIndexOf('.bin')
    if (binIndex >= 0) {
      const directory = join(nodeModules, ...segments.slice(0, binIndex + 1))
      if ((await lstat(directory)).isSymbolicLink()) await unlink(directory)
      else await rm(directory, { recursive: true, force: true })
      remaining = await findSymlink(nodeModules)
      continue
    }
    const destination = remaining
    const source = await realpath(destination)
    if (payload === source || payload.startsWith(source + sep)) {
      await unlink(destination)
      remaining = await findSymlink(nodeModules)
      continue
    }
    const nestedNodeModules = join(source, 'node_modules')
    await unlink(destination)
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
    })
    remaining = await findSymlink(nodeModules)
  }
}

/**
 * Preserve reviewed script decisions when shared-lock deploy makes workspace identities absolute.
 * @param workspace - Workspace root containing the reviewed pnpm policy.
 * @returns The same policy with local file identities expressed as absolute URLs.
 */
export async function deployedBuildPolicy(workspace: string): Promise<Record<string, boolean>> {
  const manifest: unknown = load(await readFile(join(workspace, 'pnpm-workspace.yaml'), 'utf8'))
  if (typeof manifest !== 'object' || manifest === null || !('allowBuilds' in manifest)
    || typeof manifest.allowBuilds !== 'object' || manifest.allowBuilds === null || Array.isArray(manifest.allowBuilds)) {
    throw new Error('Python deploy requires the reviewed workspace allowBuilds policy')
  }
  const result: Record<string, boolean> = {}
  for (const [identity, allowed] of Object.entries(manifest.allowBuilds)) {
    if (typeof allowed !== 'boolean') throw new Error(`Invalid build decision for ${identity}`)
    const marker = identity.indexOf('@file:')
    const deployed = marker < 0 ? identity
      : identity.slice(0, marker + 1) + pathToFileURL(resolve(workspace, identity.slice(marker + 6))).href
    if (deployed in result) throw new Error(`Duplicate deployed build identity ${deployed}`)
    result[deployed] = allowed
  }
  return result
}

/**
 * Apply only the reviewed script decisions to pnpm's generated deployment workspace.
 * @param workspace - Source workspace owning the policy.
 * @param staging - Frozen deployment whose scripts have not run yet.
 */
export async function prepareDeployedBuildPolicy(workspace: string, staging: string): Promise<void> {
  const file = join(staging, 'pnpm-workspace.yaml')
  const manifest: unknown = load(await readFile(file, 'utf8'))
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new Error('Invalid deployed workspace manifest')
  }
  await writeFile(file, dump({ ...manifest, allowBuilds: await deployedBuildPolicy(workspace) }))
}
