/** The Loader composition owns the exact writer and awaits its resource cleanup. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as SessionPlugin from '@deepseek-ai/dsh-session'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import * as JsonlPlugin from '../src/index.ts'
import { SessionHandleClosedError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionHandle, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

it('proves persistence through a Loader consumer and releases its writer, routing and lease on provider unload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-durability-loader-'))
  const ctx = new Context()
  const remounted = new Context()
  let live: { session: Session; writer: SessionHandle; persistence: SessionPersistence } | undefined
  let cleanup: Promise<void> | undefined
  const consumer = {
    name: 'durability-consumer',
    inject: ['sessionPersistence', 'sessions'],
    async apply(owner: Context) {
      const session = owner.sessions.prepare(SessionId('loader-durable'))
      const writer = await owner.sessionPersistence.create(session.header)
      const detach = owner.sessions.enter(session)
      owner.effect(() => () => {
        cleanup = writer.close().finally(detach)
        return cleanup
      })
      owner.sessions.announce(session)
      session.append('turn/start', { turn: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      live = { session, writer, persistence: owner.sessionPersistence }
    },
  }
  try {
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- id: sessions', "  name: '@deepseek-ai/dsh-session'",
      '- id: persistence', "  name: '@deepseek-ai/dsh-session-persistence-jsonl'",
      '  config:', `    root: ${JSON.stringify(root)}`, '    compression: none',
      '- id: consumer', '  name: durability-consumer', '',
    ].join('\n'))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = {
      version: 'v2', loadCache: new Map(),
      async import(specifier: string) {
        switch (specifier) {
          case '@deepseek-ai/dsh-session': return SessionPlugin
          case '@deepseek-ai/dsh-session-persistence-jsonl': return JsonlPlugin
          case 'durability-consumer': return consumer
          default: throw new Error(`Unexpected plugin: ${specifier}`)
        }
      },
      register(): never { throw new Error('Unexpected module hook registration') },
      getOrCreateModuleJob(): never { throw new Error('Unexpected module job creation') },
      resolveSync(): never { throw new Error('Unexpected synchronous module resolution') },
      load(): never { throw new Error('Unexpected module load') },
    }
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    const entries = [...ctx.loader.entries()]
    const provider = entries.find(entry => entry.options.id === 'persistence')
    const consuming = entries.find(entry => entry.options.id === 'consumer')
    if (provider?.fiber === undefined || consuming?.fiber === undefined) throw new Error('Missing Loader entries')
    await provider.fiber.await()
    await consuming.fiber.await()
    if (live === undefined) throw new Error('Consumer did not initialize')
    const { session, writer, persistence } = live
    expect(await persistence.flushSessionDurably(session)).toMatchObject({ kind: 'durable', boundary: 2 })
    await remounted.plugin(SessionPlugin.default)
    await remounted.plugin(JsonlPlugin, { root, compression: 'none' })
    const reader = await remounted.sessionPersistence.open(session.id, 'read')
    try {
      expect((await reader.read()).events).toEqual(session.snapshotEvents())
    } finally { await reader.close() }
    await provider.fiber.dispose()
    await cleanup
    expect(ctx.get('sessionPersistence')).toBeUndefined()
    for (const event of ['session/created', 'session/event', 'session/flush', 'session/disposed']) {
      expect([...ctx.events.dispatch('emit', [event])]).toHaveLength(0)
    }
    expect(await persistence.flushSessionDurably(session)).toMatchObject({ kind: 'refused' })
    await expect(writer.read()).rejects.toBeInstanceOf(SessionHandleClosedError)
    const reopened = await remounted.sessionPersistence.open(session.id, 'write')
    try {
      expect((await reopened.read()).events).toEqual(session.snapshotEvents())
    } finally { await reopened.close() }
  } finally {
    try { await ctx.fiber.dispose() } finally {
      await cleanup
      await remounted.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }
})
