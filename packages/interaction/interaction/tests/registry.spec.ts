import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  InteractionService,
  interactionProviderId,
  isBrowserActionKind,
  isDesktopActionKind,
} from '../src/index.ts'

describe('interaction provider registry', () => {
  it('rejects unsafe provider actions at the normalized facade boundary', () => {
    expect(isBrowserActionKind('click')).toBe(true)
    expect(isBrowserActionKind('run_code_unsafe')).toBe(false)
    expect(isDesktopActionKind('click')).toBe(true)
    expect(isDesktopActionKind('execute_shell')).toBe(false)
  })

  it('keeps one provider per domain and releases the exact contribution', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(InteractionService)
      const provider = {
        domain: 'browser' as const,
        describe: () => ({ id: interactionProviderId('fixture'), domains: ['browser' as const], methods: ['observe'], availability: 'ready' as const }),
        open: async () => ({ execute: async () => ({ ok: true }), close: async () => {} }),
      }
      const dispose = ctx.interaction.register(provider)
      expect(ctx.interaction.describe('browser')?.id).toBe('fixture')
      expect(() => ctx.interaction.register(provider)).toThrow('already registered')
      await dispose()
      expect(ctx.interaction.describe('browser')).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports configured providers without exposing them to unavailable domains', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(InteractionService)
      const dispose = ctx.interaction.register({
        domain: 'desktop',
        describe: () => ({ id: interactionProviderId('linux-cua'), domains: ['desktop'], availability: 'unavailable', detail: 'desktop session unavailable' }),
        open: async () => ({ execute: async () => ({ ok: true }), close: async () => {} }),
      })
      expect(ctx.interaction.describe('desktop')).toMatchObject({ availability: 'unavailable' })
      expect(ctx.interaction.describe('browser')).toBeUndefined()
      await dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
