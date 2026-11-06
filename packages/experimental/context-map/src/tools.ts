/**
 * Model tools of the project map: `context_note` for any agent, and the four curator tools that
 * only the live role holder is offered. Each curator tool re-checks the role inside the service,
 * so hiding a tool is never the enforcement.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ContextMapError } from './error.ts'
import type { MapGroupId, MapNoteId, MapPendingId, MapSnapshot } from './types.ts'
import type {} from './index.ts'

function caller(agent: Agent | undefined): Agent {
  if (agent === undefined) throw new ContextMapError('map tools require a live calling Agent', 'CONTEXT_MAP_INVALID_INPUT')
  return agent
}

const output = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown): [{ type: 'text'; text: string }] => [{ type: 'text', text: JSON.stringify(value) }],
}
const root = { root_session_id: { type: 'string' as const, description: 'Map owner Session id; required when you hold several maps.' } }
const target = (id: string | undefined) => id === undefined ? {} : { rootSessionId: SessionId(id) }
const revision = { type: 'integer' as const, required: true as const, description: 'Revision from map_view; the edit is rejected if the map moved on.' }

function summary(snapshot: MapSnapshot): { revision: number; groups: number; pending: number; core: number } {
  return { revision: snapshot.revision, groups: snapshot.groups.length, pending: snapshot.pending.length, core: snapshot.core.length }
}

function required<T>(value: T | undefined, name: string, action: string): T {
  if (value === undefined) throw new ContextMapError(`${action} needs ${name}`, 'CONTEXT_MAP_INVALID_INPUT')
  return value
}

/** Opt-in registration of `context_note` and the curator tools. */
export class ContextMapTools extends Service {
  static inject = ['tools', 'contextMap']
  constructor(ctx: Context) { super(ctx, 'contextMapTools') }

  protected [Service.init](): void {
    const isCurator = ({ agent }: { agent: Agent }): boolean => this.ctx.contextMap.isCurator(agent)
    this.ctx.tools.register(defineTool({
      name: 'context_note',
      description:
        'Record one short fact about this project for the project map, such as where something lives or a convention '
        + 'you had to discover. A background curator checks and files it; you get no reply to wait for. '
        + 'Cite the context sections (sec_… ids from context_browse) or evidence ("ref:" and a short pointer) it rests on. '
        + 'Do not record plans, progress, or anything already in the instructions.',
      parameters: {
        text: { type: 'string', required: true, description: 'The fact, in one or two sentences.' },
        cites: { type: 'array', items: { type: 'string' }, description: 'Section ids or "ref:…" evidence the fact rests on.' },
      },
      output,
      execute: async (args, exec) => {
        const result = await this.ctx.contextMap.note(caller(exec.agent), {
          text: args.text,
          ...args.cites === undefined ? {} : { cites: args.cites },
        }, exec.signal)
        return z.json().parse({ filed: result.id, waiting: result.pending })
      },
    }))
    this.ctx.tools.register(defineTool({
      name: 'map_view',
      description: 'Read the project map, core, pending notes, and stale flags. Follow nextPendingAfter as pending_after and nextGroupAfter as group_after even after edits. For a group with omittedNotes, read group_id with note_after from nextNoteAfter until complete. Group pages omit pending notes.',
      parameters: {
        ...root,
        pending_after: { type: 'string', description: 'Continue pending notes after this id; use nextPendingAfter.' },
        group_after: { type: 'string', description: 'Continue groups after this id; use nextGroupAfter, or an empty string to start groups only.' },
        group_id: { type: 'string', description: 'Read one group and its notes without pending notes.' },
        note_after: { type: 'string', description: 'Continue group_id notes after this id; use nextNoteAfter.' },
      },
      output,
      execute: async (args, exec) => {
        const agent = caller(exec.agent)
        if (!this.ctx.contextMap.isCurator(agent, args.root_session_id === undefined ? undefined : SessionId(args.root_session_id))) {
          throw new ContextMapError('Only the live curator may run map_view', 'CONTEXT_MAP_UNAUTHORIZED')
        }
        const view = await this.ctx.contextMap.view(
          agent,
          {
            ...target(args.root_session_id),
            ...args.pending_after === undefined ? {} : { pendingAfter: brandString<MapPendingId>(args.pending_after) },
            ...args.group_after === undefined ? {} : { groupAfter: args.group_after === '' ? '' as const : brandString<MapGroupId>(args.group_after) },
            ...args.group_id === undefined ? {} : { groupId: brandString<MapGroupId>(args.group_id) },
            ...args.note_after === undefined ? {} : { noteAfter: args.note_after === '' ? '' as const : brandString<MapNoteId>(args.note_after) },
          },
          exec.signal,
        )
        if (!this.ctx.contextMap.isCurator(agent, args.root_session_id === undefined ? undefined : SessionId(args.root_session_id))) {
          throw new ContextMapError('Only the live curator may run map_view', 'CONTEXT_MAP_UNAUTHORIZED')
        }
        return z.json().parse(view)
      },
    }), { when: isCurator })
    this.ctx.tools.register(defineTool({
      name: 'map_group',
      description:
        'Create, replace, merge, or retire a group. set: path "Root/Origin/name" (Root is Instructions, Sources, or Tools; '
        + 'Origin is Global or Project), title, one-line summary saying when to use the members, and sections or tools; '
        + 'pass group_id to replace a group. merge: moves from_group and its notes into group_id. retire: removes group_id and its notes.',
      parameters: {
        ...root,
        action: { type: 'string', required: true, enum: ['set', 'merge', 'retire'], description: 'What to do.' },
        expected_revision: revision,
        group_id: { type: 'string', description: 'Existing group (replace, merge target, retire).' },
        from_group: { type: 'string', description: 'merge: group to fold in.' },
        path: { type: 'string', description: 'set: Root/Origin/name.' },
        title: { type: 'string', description: 'set: short title.' },
        summary: { type: 'string', description: 'set: one line saying when to use these.' },
        sections: { type: 'array', items: { type: 'string' }, description: 'set: member section ids.' },
        tools: { type: 'array', items: { type: 'string' }, description: 'set: member tool names (Tools groups).' },
      },
      output,
      execute: async (args, exec) => {
        const agent = caller(exec.agent)
        const map = this.ctx.contextMap
        const expectedRevision = args.expected_revision
        const mapTarget = target(args.root_session_id)
        const groupId = args.group_id === undefined ? undefined : brandString<MapGroupId>(args.group_id)
        if (args.action === 'retire') {
          return z.json().parse(summary(await map.retireGroup(agent, { ...mapTarget, expectedRevision, groupId: required(groupId, 'group_id', 'retire') }, exec.signal)))
        }
        if (args.action === 'merge') {
          const from = brandString<MapGroupId>(required(args.from_group, 'from_group', 'merge'))
          return z.json().parse(summary(await map.mergeGroups(agent, { ...mapTarget, expectedRevision, from, into: required(groupId, 'group_id', 'merge') }, exec.signal)))
        }
        return z.json().parse(summary(await map.setGroup(agent, {
          ...mapTarget, expectedRevision,
          group: {
            ...groupId === undefined ? {} : { groupId },
            path: required(args.path, 'path', 'set'),
            title: required(args.title, 'title', 'set'),
            summary: required(args.summary, 'summary', 'set'),
            ...args.sections === undefined ? {} : { sections: args.sections },
            ...args.tools === undefined ? {} : { tools: args.tools },
          },
        }, exec.signal)))
      },
    }), { when: isCurator })
    this.ctx.tools.register(defineTool({
      name: 'map_note',
      description:
        'Manage notes. add: file a note under group_id; cites must name sections you read or "ref:" evidence. '
        + 'file: move a pending note (pending_id) under group_id, optionally rewriting text and adding cites. '
        + 'verify: re-read the sources of a stale note, then call this to refresh its hashes (optionally correcting text). '
        + 'retire: delete a filed note. drop: discard a pending note. A note can never cite another note.',
      parameters: {
        ...root,
        action: { type: 'string', required: true, enum: ['add', 'file', 'verify', 'retire', 'drop'], description: 'What to do.' },
        expected_revision: revision,
        group_id: { type: 'string', description: 'add, file: destination group.' },
        note_id: { type: 'string', description: 'verify, retire: filed note.' },
        pending_id: { type: 'string', description: 'file, drop: pending note.' },
        text: { type: 'string', description: 'add: the note; file, verify: replacement text.' },
        cites: { type: 'array', items: { type: 'string' }, description: 'add, file: section ids or "ref:…" evidence.' },
      },
      output,
      execute: async (args, exec) => {
        const agent = caller(exec.agent)
        const map = this.ctx.contextMap
        const expectedRevision = args.expected_revision
        const mapTarget = target(args.root_session_id)
        const groupId = (action: string): MapGroupId => brandString<MapGroupId>(required(args.group_id, 'group_id', action))
        const noteId = (action: string): MapNoteId => brandString<MapNoteId>(required(args.note_id, 'note_id', action))
        const pendingId = (action: string): MapPendingId => brandString<MapPendingId>(required(args.pending_id, 'pending_id', action))
        switch (args.action) {
          case 'add':
            return z.json().parse(summary(await map.addNote(agent, {
              ...mapTarget, expectedRevision, groupId: groupId('add'), text: required(args.text, 'text', 'add'), cites: args.cites ?? [],
            }, exec.signal)))
          case 'file':
            return z.json().parse(summary(await map.filePending(agent, {
              ...mapTarget, expectedRevision,
              pendingId: pendingId('file'),
              groupId: groupId('file'),
              ...args.text === undefined ? {} : { text: args.text },
              ...args.cites === undefined ? {} : { cites: args.cites },
            }, exec.signal)))
          case 'verify':
            return z.json().parse(summary(await map.verifyNote(agent, {
              ...mapTarget, expectedRevision, noteId: noteId('verify'), ...args.text === undefined ? {} : { text: args.text },
            }, exec.signal)))
          case 'retire':
            return z.json().parse(summary(await map.retireNote(agent, { ...mapTarget, expectedRevision, noteId: noteId('retire') }, exec.signal)))
          case 'drop':
            return z.json().parse(summary(await map.dropPending(agent, { ...mapTarget, expectedRevision, pendingId: pendingId('drop') }, exec.signal)))
        }
      },
    }), { when: isCurator })
    this.ctx.tools.register(defineTool({
      name: 'map_core',
      description: 'Choose the sections granted up front at the start of every conversation, most important first. Keep it small: each costs context in every session.',
      parameters: {
        ...root,
        expected_revision: revision,
        sections: { type: 'array', required: true, items: { type: 'string' }, description: 'Section ids in priority order; an empty list clears the core.' },
      },
      output,
      execute: async (args, exec) => z.json().parse(summary(await this.ctx.contextMap.setCore(caller(exec.agent), {
        ...target(args.root_session_id), expectedRevision: args.expected_revision, sections: args.sections,
      }, exec.signal))),
    }), { when: isCurator })
  }
}

export default ContextMapTools
