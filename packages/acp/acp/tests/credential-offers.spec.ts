/** An open ACP session follows the model offers of a credential that is replaced under it. */

import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { makeBridgeHarness, type BridgeHarness, type CapturedUpdate } from './harness.ts'

/** A Copilot grant whose account may call exactly these models. */
const grant = (availableModelIds: readonly string[]) => ({
  kind: 'grant' as const,
  payload: { type: 'oauth', access: 'a', refresh: 'r', expires: 4102444800000, availableModelIds: [...availableModelIds] },
})

/** Model names the config option offers under one provider group. */
function offered(configOptions: readonly { id: string; type: string; options?: unknown }[], group: string): string[] {
  const model = configOptions.find(option => option.id === 'model')
  if (model?.type !== 'select') throw new Error('expected a model select option')
  const options = model.options as Array<{ group?: string; options?: Array<{ value: string }> }>
  const entry = options.find(option => option.group === group)
  return (entry?.options ?? []).map(option => (JSON.parse(option.value) as string[])[1]!)
}

describe('ACP model offers after a credential replacement', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('sends the new offers, without the old ones, when a grant is replaced and the routes stay', async () => {
    harness = await makeBridgeHarness()
    const { ctx } = harness
    await ctx.plugin(LocalCredentialProvider, { path: join(harness.persistenceRoot, 'credentials.yaml'), watch: false })
    const key = PiAi.recordKeyFor('github-copilot')
    await ctx.credentials.modifyRecord(key, () => Promise.resolve({
      kind: 'grant', payload: { type: 'oauth', access: 'a', refresh: 'r', expires: 4102444800000 },
    }))
    await ctx.plugin(PiAi)
    const every = (await ctx.llm.listModels('github-copilot')).map(model => model.id)
    const [first, second] = every
    expect(every.length).toBeGreaterThan(2)
    await ctx.credentials.modifyRecord(key, () => Promise.resolve(grant([first!])))

    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(offered(created.configOptions ?? [], 'github-copilot')).toEqual([first])
    expect(harness.updates.filter(update => update.sessionUpdate === 'config_option_update')).toEqual([])
    const before = ctx.llm.listProviders().map(provider => provider.id)

    // No route changes: the same provider ids stay registered, so only the credential announces it.
    await ctx.credentials.modifyRecord(key, () => Promise.resolve(grant([second!])))
    let update: Extract<CapturedUpdate, { sessionUpdate: 'config_option_update' }> | undefined
    await vi.waitFor(() => {
      update = harness?.updates.find(item => item.sessionUpdate === 'config_option_update')
      expect(update).toBeDefined()
    })
    if (update === undefined) throw new Error('expected a config option update')

    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(before)
    expect(offered(update.configOptions, 'github-copilot')).toEqual([second])
    expect(offered(update.configOptions, 'github-copilot')).not.toContain(first)
  })
})
