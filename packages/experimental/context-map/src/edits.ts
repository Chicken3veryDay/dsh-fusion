/**
 * Pure validation and construction for map edits: group paths, membership against the live index,
 * citations with sources, and staleness. Nothing here reads or writes a Session.
 */
import { createHash } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContextSectionId, ContextSectionMeta, ContextSourceKind } from '@deepseek-ai/dsh-experimental-context-index/types'
import type { ResolvedConfig } from './config.ts'
import { ContextMapError } from './error.ts'
import { byteLength, oneLine } from './text.ts'
import type { MapCite, MapGroup, MapGroupId, MapGroupRequest, MapNote, MapSnapshot } from './types.ts'

/** What the live index says about the sections a map may cite. */
export interface IndexFacts {
  readonly sections: ReadonlyMap<ContextSectionId, ContextSectionMeta>
  /** Digest of every section id and hash; changes when any indexed text changes. */
  readonly digest: string
  /** Hash of the text the latest read of each section returned; it differs from the index hash when the file changed after that read. */
  readonly read: ReadonlyMap<ContextSectionId, string>
}

/** Roots a group may sit under. */
export const MAP_ROOTS = ['Instructions', 'Sources', 'Tools'] as const

/** A parsed group path. */
export interface GroupPath {
  readonly root: (typeof MAP_ROOTS)[number]
  readonly origin: 'global' | 'project'
  readonly name: string
}

const SECTION_ID = /^sec_[0-9a-f]{16}$/
const MEMBER_ID = /^(grp|note|pnd)_/

function invalid(message: string): never {
  throw new ContextMapError(message, 'CONTEXT_MAP_INVALID_INPUT')
}

/**
 * Digest of the index content a map was last processed against.
 * @param sections - index sections.
 * @returns a stable digest.
 */
export function digestOf(sections: readonly ContextSectionMeta[]): string {
  return createHash('sha256').update(sections.map(section => `${section.id}:${section.hash}`).join('\n')).digest('hex')
}

/**
 * Parse a group path.
 * @param path - `Root/Origin/name`.
 * @returns its parts.
 * @throws {@link ContextMapError} `CONTEXT_MAP_INVALID_INPUT` for any other shape.
 */
export function parseGroupPath(path: string): GroupPath {
  const parts = path.split('/')
  const [root, origin, name] = parts
  if (parts.length !== 3 || !(MAP_ROOTS as readonly string[]).includes(root ?? '') || (origin !== 'Global' && origin !== 'Project')
    || name === undefined || name.trim() === '' || name !== name.trim() || /[%\u0000-\u001f]/.test(name) || byteLength(name) > 64) {
    invalid(`group path "${path}" must be Instructions, Sources, or Tools, then Global or Project, then a name of at most 64 bytes`)
  }
  return { root: root as GroupPath['root'], origin: origin === 'Global' ? 'global' : 'project', name: name }
}

/**
 * Where a section can be grouped.
 * @param kind - the section's source kind.
 * @returns the root and origin its group must have.
 */
export function homeOf(kind: ContextSourceKind): Pick<GroupPath, 'root' | 'origin'> {
  if (kind === 'user-instructions') return { root: 'Instructions', origin: 'global' }
  if (kind === 'project-instructions') return { root: 'Instructions', origin: 'project' }
  return { root: 'Sources', origin: 'project' }
}

function oneLineBounded(text: string, name: string, max: number): string {
  const line = oneLine(text)
  if (line === '') invalid(`${name} must not be empty`)
  if (byteLength(line) > max) invalid(`${name} is ${byteLength(line)} bytes; the limit is ${max}`)
  return line
}

/**
 * Check one section id against the index and a group's home.
 * @param raw - candidate id.
 * @param facts - live index facts.
 * @returns the branded id.
 * @throws {@link ContextMapError} `CONTEXT_MAP_NOT_FOUND` for an unknown section.
 */
export function knownSection(raw: string, facts: IndexFacts): ContextSectionId {
  const id = SECTION_ID.test(raw) ? brandString<ContextSectionId>(raw) : undefined
  if (id === undefined || !facts.sections.has(id)) {
    throw new ContextMapError(`"${raw}" is not a section in the current index`, 'CONTEXT_MAP_NOT_FOUND')
  }
  return id
}

/** Metadata of a section already checked against `facts` by {@link knownSection} or a membership test. */
function sectionMeta(id: ContextSectionId, facts: IndexFacts): ContextSectionMeta {
  return facts.sections.get(id) as ContextSectionMeta
}

/**
 * Build a group from a request, checking membership against the index and the rest of the map.
 * @param request - the edit.
 * @param id - id for a new group, or the replaced group's id.
 * @param notes - notes the group keeps.
 * @param facts - live index facts.
 * @param snapshot - the map the group joins; its other groups may not claim the same path or member.
 * @param config - bounds.
 * @returns the group.
 * @throws {@link ContextMapError} for a bad path, unknown or misplaced member, duplicate, or exceeded bound.
 */
export function buildGroup(
  request: MapGroupRequest,
  id: MapGroupId,
  notes: readonly MapNote[],
  facts: IndexFacts,
  snapshot: MapSnapshot,
  config: ResolvedConfig,
): MapGroup {
  const path = parseGroupPath(request.path)
  const sections = [...new Set((request.sections ?? []).map(raw => knownSection(raw, facts)))]
  const tools = [...new Set(request.tools ?? [])]
  if (path.root === 'Tools' && sections.length > 0) invalid('a group under Tools holds tools, not sections')
  if (path.root !== 'Tools' && tools.length > 0) invalid('a group under Instructions or Sources holds sections, not tools')
  if (sections.length + tools.length === 0) invalid('a group needs at least one member')
  if (sections.length + tools.length > config.maxGroupMembers) {
    throw new ContextMapError(`a group holds at most ${config.maxGroupMembers} members`, 'CONTEXT_MAP_LIMIT')
  }
  if (tools.some(tool => tool.trim() === '' || /\s/.test(tool))) invalid('tool names must not be empty or hold whitespace')
  for (const section of sections) {
    const home = homeOf(sectionMeta(section, facts).kind)
    if (home.root !== path.root || home.origin !== path.origin) {
      invalid(`section ${section} belongs under ${home.root}/${home.origin === 'global' ? 'Global' : 'Project'}, not ${request.path}`)
    }
  }
  const others = snapshot.groups.filter(group => group.id !== id)
  if (others.some(group => group.path === request.path)) {
    throw new ContextMapError(`a group already sits at ${request.path}`, 'CONTEXT_MAP_CONFLICT')
  }
  const holds = (group: MapGroup): boolean => group.sections.some(section => sections.includes(section))
    || group.tools.some(tool => tools.includes(tool))
  const taken = others.find(holds)
  if (taken !== undefined) throw new ContextMapError(`group ${taken.id} already holds one of these members`, 'CONTEXT_MAP_CONFLICT')
  return {
    id,
    path: request.path,
    title: oneLineBounded(request.title, 'title', config.maxTitleBytes),
    summary: oneLineBounded(request.summary, 'summary', config.maxSummaryBytes),
    sections,
    tools,
    notes,
  }
}

/**
 * The hash a citation of a section carries: the hash of the text last read from it, which is the
 * text a citer checked, or the indexed hash when nobody read the section. A citer cannot claim a
 * hash the index did not serve.
 */
function citedHash(id: ContextSectionId, facts: IndexFacts): string {
  return facts.read.get(id) ?? sectionMeta(id, facts).hash
}

/**
 * Turn model-supplied citation strings into typed citations. A `sec_…` id becomes a section citation
 * stamped with the hash of the text last read from it (see {@link citedHash}), so a file edited after
 * that read leaves the note stale; a `ref:…` string becomes an evidence citation. Anything that names
 * a note is refused.
 * @param raw - citation strings.
 * @param facts - live index facts.
 * @param snapshot - the map, whose note ids a citation may not name.
 * @param config - bounds.
 * @returns the citations, without duplicates.
 * @throws {@link ContextMapError} for a note citation, an unknown section, an unknown form, or too many citations.
 */
export function parseCites(raw: readonly string[], facts: IndexFacts, snapshot: MapSnapshot, config: ResolvedConfig): MapCite[] {
  const known = [...snapshot.groups.flatMap(group => group.notes.map(note => note.id)), ...snapshot.pending.map(note => note.id)]
  const cites: MapCite[] = []
  for (const entry of raw) {
    const text = entry.trim()
    if (MEMBER_ID.test(text) || known.some(id => text.includes(id))) invalid(`"${text}" names a note; notes cite sources or evidence, never other notes`)
    if (text.startsWith('ref:')) {
      const ref = oneLineBounded(text.slice(4), 'evidence reference', config.maxEvidenceBytes)
      if (MEMBER_ID.test(ref)) invalid('an evidence reference may not name a note')
      cites.push({ kind: 'evidence', ref })
    } else if (SECTION_ID.test(text)) {
      const id = knownSection(text, facts)
      cites.push({ kind: 'section', id, hash: citedHash(id, facts) })
    } else {
      invalid(`citation "${text}" must be a section id (sec_…) or "ref:" followed by an evidence reference`)
    }
  }
  const unique = cites.filter((cite, index) => cites.findIndex(other => JSON.stringify(other) === JSON.stringify(cite)) === index)
  if (unique.length > config.maxCitesPerNote) {
    throw new ContextMapError(`a note carries at most ${config.maxCitesPerNote} citations`, 'CONTEXT_MAP_LIMIT')
  }
  return unique
}

/**
 * Check a note's text.
 * @param text - note text.
 * @param config - bounds.
 * @returns the text on one line.
 */
export function noteText(text: string, config: ResolvedConfig): string {
  return oneLineBounded(text, 'note', config.maxNoteBytes)
}

/**
 * Whether a note's sources changed since it was checked.
 * @param cites - the note's citations.
 * @param facts - live index facts.
 * @returns true when a cited section is gone or has a different hash.
 */
export function isStale(cites: readonly MapCite[], facts: IndexFacts): boolean {
  return cites.some(cite => cite.kind === 'section' && facts.sections.get(cite.id)?.hash !== cite.hash)
}

/**
 * Re-stamp a note's section citations with the hashes of the text last read from them (see {@link citedHash}).
 * @param cites - the note's citations.
 * @param facts - live index facts.
 * @returns citations with the hashes of the text read; current hashes once the sources were read again.
 * @throws {@link ContextMapError} `CONTEXT_MAP_NOT_FOUND` when a cited section no longer exists.
 */
export function restamp(cites: readonly MapCite[], facts: IndexFacts): MapCite[] {
  return cites.map((cite) => {
    if (cite.kind === 'evidence') return cite
    if (!facts.sections.has(cite.id)) {
      throw new ContextMapError(`cited section ${cite.id} no longer exists; retire the note or cite another source`, 'CONTEXT_MAP_NOT_FOUND')
    }
    return { kind: 'section', id: cite.id, hash: citedHash(cite.id, facts) }
  })
}
