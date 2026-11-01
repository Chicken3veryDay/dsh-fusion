/** Actual retained JSONL prefixes, torn raw/zstd frames and repeated restart repair. */
import { createZstdCompress, constants } from 'node:zlib'
import { finished } from 'node:stream/promises'
import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { sessionDir, scanLog } from '@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts'
import { compressZstdFrame, decompressZstdPrefix, scanZstdFrames } from '@deepseek-ai/dsh-session-persistence-jsonl/src/zstd.ts'
import { intentSchema } from '../src/delivery-state.ts'
import { DeliveryId } from '../src/index.ts'
import { mount, read } from './harness.ts'

function noise(length: number): string {
  let output = ''
  for (let index = 0; output.length < length; index++) output += createHash('sha256').update(String(index)).digest('base64')
  return output.slice(0, length)
}

it.each(['neither', 'acceptance', 'pair', 'completed'] as const)('repairs actual raw surviving %s prefix and never changes reconstruction or revision', async (prefix) => {
  const { ctx, root, adapter } = await mount()
  const task = await ctx.fusionParticipants.prepare('single-test')
  const target = task.roster.roles.participant!
  const input = { deliveryId: DeliveryId('prefix'), targetParticipantId: target, inboxTarget: 'next-turn' as const, correlationId: 'source', text: 'reconstruct exactly\r\n𝄞' }
  const receipt = await task.delivery.admitUser(input)
  await task.dispose()
  const rootPath = join(sessionDir(root, undefined, task.roster.rootSessionId), 'session.v4.jsonl')
  const targetPath = join(sessionDir(root, undefined, target), 'session.v4.jsonl')
  const rootRows = (await readFile(rootPath, 'utf8')).trimEnd().split('\n')
  const targetRows = (await readFile(targetPath, 'utf8')).trimEnd().split('\n')
  if (prefix !== 'completed') {
    await writeFile(rootPath, `${rootRows.slice(0, rootRows.findIndex(row => row.includes('"type":"fusion/delivery-completed"'))).join('\n')}\n`)
  }
  const acceptance = targetRows.findIndex(row => row.includes('"type":"fusion/delivery-accepted"'))
  const end = prefix === 'neither' ? acceptance : prefix === 'acceptance' ? acceptance + 1 : acceptance + 2
  const torn = prefix === 'completed' ? '' : targetRows[end]?.slice(0, 20) ?? '{"type":"torn'
  await writeFile(targetPath, `${targetRows.slice(0, end).join('\n')}\n${torn}`)
  expect(scanLog(await readFile(targetPath)).events.filter(row => row.type === 'fusion/delivery-accepted')).toHaveLength(prefix === 'neither' ? 0 : 1)
  const second = await mount(root)
  const recovered = await second.ctx.fusionParticipants.recover(task.roster.rootSessionId)
  const repaired = await recovered.delivery.admitUser(input)
  expect(repaired).toMatchObject({ deliveryId: receipt.deliveryId, messageId: receipt.messageId,
    order: receipt.order, decisionInputRevision: receipt.decisionInputRevision, contentHash: receipt.contentHash })
  expect(await recovered.delivery.admitUser(input)).toEqual(repaired)
  const after = await read(second.ctx, target)
  expect(after.filter(row => row.type === 'fusion/delivery-accepted')).toHaveLength(1)
  expect(after.filter(row => row.type === 'agent/inbox/spliced' && row.data.inserted.length > 0)).toHaveLength(1)
  const original = scanLog(Buffer.from(`${targetRows.join('\n')}\n`)).events.find(row => row.type === 'agent/inbox/spliced')
  expect(after.find(row => row.type === 'agent/inbox/spliced')?.data).toEqual(original?.data)
  const parked = await recovered.adopt('participant')
  expect(parked.agent.inbox.nextTurn.map(row => row.id)).toEqual([receipt.messageId])
  expect(adapter.requests).toHaveLength(0)
  expect(second.adapter.requests).toHaveLength(0)
  await recovered.dispose()
  const third = await mount(root)
  const again = await third.ctx.fusionParticipants.recover(task.roster.rootSessionId)
  expect(await again.delivery.admitUser(input)).toEqual(repaired)
  await again.dispose()
})

it('repairs acceptance-only after multiple resume housekeeping gaps and an interrupted turn', async () => {
  const { ctx, root } = await mount()
  const task = await ctx.fusionParticipants.prepare('single-test')
  const target = task.roster.roles.participant!
  const session = ctx.sessions.get(target)!
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const originalAppend = session.append.bind(session)
  const append = vi.spyOn(session, 'append').mockImplementation((...args) => {
    if (args[0] === 'fusion/delivery-accepted') return originalAppend('fusion/delivery-accepted', intentSchema.parse(args[1]))
    throw new Error('crash before insertion')
  })
  const input = { deliveryId: DeliveryId('repeated'), targetParticipantId: target, inboxTarget: 'next-turn' as const, correlationId: null, text: 'pending reconstruction' }
  await expect(task.delivery.admitUser(input)).rejects.toThrow()
  append.mockRestore()
  await task.dispose()
  const second = await mount(root)
  const flush = second.ctx.sessionPersistence.flushSessionDurably.bind(second.ctx.sessionPersistence)
  let rootBarriers = 0
  const failure = vi.spyOn(second.ctx.sessionPersistence, 'flushSessionDurably').mockImplementation(async (session) => {
    if (session.id === task.roster.rootSessionId) rootBarriers++
    const events = await read(second.ctx, session.id)
    if (session.id === task.roster.rootSessionId && rootBarriers >= 3 && events.some(row => row.type === 'fusion/delivery-intent')) {
      return { kind: 'refused', reason: 'coverage' }
    }
    return flush(session)
  })
  await expect(second.ctx.fusionParticipants.recover(task.roster.rootSessionId)).rejects.toThrow()
  failure.mockRestore()
  const path = join(sessionDir(root, undefined, target), 'session.v4.jsonl')
  const surviving = scanLog(await readFile(path))
  await writeFile(path, `${JSON.stringify({ type: 'session/end-seed', seq: surviving.events.length, time: 0, data: {} })}\n`, { flag: 'a' })
  const third = await mount(root)
  const recovered = await third.ctx.fusionParticipants.recover(task.roster.rootSessionId)
  const receipt = await recovered.delivery.admitUser(input)
  const events = await read(third.ctx, target)
  const accepted = events.find(row => row.type === 'fusion/delivery-accepted')!
  const inserted = events.find(row => row.type === 'agent/inbox/spliced')!
  expect(events.filter(row => row.type === 'session/end-seed').length).toBeGreaterThanOrEqual(2)
  expect(inserted.seq).toBeGreaterThan(accepted.seq + 1)
  expect(receipt.decisionInputRevision).toBe(1)
  expect(events.filter(row => row.type === 'step/end')).toHaveLength(1)
  expect(events.filter(row => row.type === 'turn/end')).toHaveLength(1)
  await recovered.dispose()
})

it.each([0, 1, 2])('independently decodes a torn zstd batch with %i surviving receiver records before retained repair', async (count) => {
  const { ctx, root } = await mount()
  const task = await ctx.fusionParticipants.prepare('single-test')
  const target = task.roster.roles.participant!
  const input = { deliveryId: DeliveryId('zstd-prefix'), targetParticipantId: target, inboxTarget: 'next-turn' as const, correlationId: null, text: noise(350_000) }
  const receipt = await task.delivery.admitUser(input)
  await task.dispose()
  const rootPath = join(sessionDir(root, undefined, task.roster.rootSessionId), 'session.v4.jsonl')
  const rawPath = join(sessionDir(root, undefined, target), 'session.v4.jsonl')
  const rows = (await readFile(rawPath, 'utf8')).trimEnd().split('\n')
  const acceptance = rows.findIndex(row => row.includes('"type":"fusion/delivery-accepted"'))
  const batch = `${rows.slice(acceptance, acceptance + 2).join('\n')}\n`
  const compressor = createZstdCompress({ params: { [constants.ZSTD_c_checksumFlag]: 1 } })
  const chunks: Buffer[] = []
  compressor.on('data', (chunk: Buffer) => chunks.push(chunk))
  const firstLineEnd = batch.indexOf('\n') + 1
  const split = count === 0 ? Math.floor(firstLineEnd / 2) : firstLineEnd
  compressor.write(batch.slice(0, split))
  await new Promise<void>((resolve, reject) => {
    compressor.once('error', reject)
    compressor.flush(constants.ZSTD_e_flush, () => {
      compressor.off('error', reject)
      resolve()
    })
  })
  let torn = Buffer.concat(chunks)
  compressor.end(batch.slice(split))
  await finished(compressor)
  if (count === 2) torn = Buffer.concat(chunks).subarray(0, Buffer.concat(chunks).length - 1)
  expect(scanZstdFrames(torn).tornStart).toBe(0)
  const emitted = (await decompressZstdPrefix(torn)).toString('utf8')
  expect(emitted.match(/\n/g)?.length ?? 0).toBe(count)
  const compressedPath = `${rawPath}.zstd`
  await writeFile(compressedPath, Buffer.concat([await compressZstdFrame(`${rows[0]}\n`),
    await compressZstdFrame(`${rows.slice(1, acceptance).join('\n')}\n`), torn]))
  await rm(rawPath)
  const rootRows = (await readFile(rootPath, 'utf8')).trimEnd().split('\n')
  await writeFile(`${rootPath}.zstd`, Buffer.concat([await compressZstdFrame(`${rootRows[0]}\n`), await compressZstdFrame(`${rootRows.slice(1, rootRows.findIndex(row => row.includes('"type":"fusion/delivery-completed"'))).join('\n')}\n`)]))
  await rm(rootPath)
  const second = await mount(root, 'zstd')
  const independent = await read(second.ctx, target)
  expect(independent.slice(acceptance - 1)).toHaveLength(count)
  const recovered = await second.ctx.fusionParticipants.recover(task.roster.rootSessionId)
  const repaired = await recovered.delivery.admitUser(input)
  expect(repaired).toMatchObject({ messageId: receipt.messageId, order: receipt.order, decisionInputRevision: 1 })
  expect(scanZstdFrames(await readFile(compressedPath)).tornStart).toBeUndefined()
  const events = await read(second.ctx, target)
  expect(events.filter(row => row.type === 'agent/inbox/spliced' && row.data.inserted.length > 0)).toHaveLength(1)
  expect(events.map(row => row.seq)).toEqual(events.map((_, index) => SessionSeq(index)))
  expect(second.adapter.requests).toHaveLength(0)
  await recovered.dispose()
  const third = await mount(root, 'zstd')
  const again = await third.ctx.fusionParticipants.recover(task.roster.rootSessionId)
  expect(await again.delivery.admitUser(input)).toEqual(repaired)
  await again.dispose()
})
