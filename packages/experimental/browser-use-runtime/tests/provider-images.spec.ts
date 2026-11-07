/** Public MCP image projection preserves content order and admits durable images as one batch. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachments from '@deepseek-ai/dsh-attachment-local'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { afterEach, expect, it, vi } from 'vitest'
import { projectProviderImages, validateBrowserMcpConfig } from '../src/mcp.ts'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'
const image = { type: 'image', data: png, mimeType: 'image/png' }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function storage() {
  const root = await mkdtemp(join(tmpdir(), 'browser-images-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalAttachments, { dshHome: root })
  return ctx
}

it.each<JsonValue>([null, [], 'plain', {}, { content: null }, { content: [null, [], 'text', {}, { type: 'text', text: 'ok' }] }])(
  'preserves results without encoded image blocks: %j', async (result) => {
    expect(await projectProviderImages(new Context(), result, 'capture')).toBe(result)
  },
)

it.each<JsonValue>([
  { type: 'image', mimeType: 'image/png' }, { type: 'image', data: png },
  { type: 'image', data: 1, mimeType: 'image/png' }, { type: 'image', data: png, mimeType: 1 },
])('refuses malformed image fields before storage: %j', async (block) => {
  await expect(projectProviderImages(new Context(), { content: [block] }, 'capture')).rejects.toThrow('capture" returned an invalid image block')
})

it.each(['', '!', 'YQ', 'YQ==\n'])('refuses non-canonical image bytes %j', async (data) => {
  await expect(projectProviderImages(new Context(), { content: [{ ...image, data }] }, 'capture')).rejects.toThrow('non-canonical image data')
})

it('requires attachment storage for encoded images', async () => {
  await expect(projectProviderImages(new Context(), { content: [image] }, 'capture')).rejects.toThrow('no attachment store is configured')
})

it('stores an ordered batch and preserves text, metadata, and the original result', async () => {
  const ctx = await storage()
  const save = vi.spyOn(ctx.attachments, 'saveImages')
  const result = { content: [image, { type: 'text', text: 'between' }, image], isError: false }
  const projected = await projectProviderImages(ctx, result, 'capture')
  expect(save).toHaveBeenCalledExactlyOnceWith([
    { data: new Uint8Array(Buffer.from(png, 'base64')), mediaType: 'image/png' },
    { data: new Uint8Array(Buffer.from(png, 'base64')), mediaType: 'image/png' },
  ])
  const saved = save.mock.results[0]!
  if (saved.type !== 'return') throw new Error('image batch did not return its durable references')
  const refs = await saved.value
  expect(projected).toEqual({ content: [
    { type: 'image', attachment: refs[0] }, { type: 'text', text: 'between' }, { type: 'image', attachment: refs[1] },
  ], isError: false })
  expect((await ctx.attachments.readImage(refs[0]!)).data).toEqual(new Uint8Array(Buffer.from(png, 'base64')))
  expect(result.content[0]).toBe(image)
})

it('preserves optional attachment metadata returned by admission', async () => {
  const ctx = await storage()
  const ref = await ctx.attachments.saveImage({ data: new Uint8Array(Buffer.from(png, 'base64')), mediaType: 'image/png', name: 'capture.png' })
  const detailed = { ...ref, originalDimensions: { width: 2, height: 2 } }
  vi.spyOn(ctx.attachments, 'saveImages').mockResolvedValueOnce([detailed])
  expect(await projectProviderImages(ctx, { content: [image] }, 'capture')).toEqual({ content: [{ type: 'image', attachment: detailed }] })
})

it('refuses an incomplete attachment batch', async () => {
  const ctx = await storage()
  vi.spyOn(ctx.attachments, 'saveImages').mockResolvedValueOnce([])
  await expect(projectProviderImages(ctx, { content: [image] }, 'capture')).rejects.toThrow('image admission returned too few references')
})

it('rejects malformed attach URLs and accepts launch without an endpoint', () => {
  expect(() => { validateBrowserMcpConfig({ mode: 'launch', headless: true }) }).not.toThrow()
  expect(() => { validateBrowserMcpConfig({ mode: 'attach', endpoint: 'http://' }) }).toThrow('valid HTTP(S) or WS(S) URL')
  expect(() => { validateBrowserMcpConfig({ mode: 'attach', endpoint: 'ftp://example.invalid' }) }).toThrow('without whitespace')
  expect(() => { validateBrowserMcpConfig({ mode: 'attach', endpoint: 'https://example.invalid/ ' }) }).toThrow('without whitespace')
  expect(() => { validateBrowserMcpConfig({ mode: 'attach', endpoint: 'https://example.invalid/' }) }).not.toThrow()
})
