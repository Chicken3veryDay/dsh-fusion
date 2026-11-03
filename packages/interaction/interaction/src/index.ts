/** Stable agent-owned browser and desktop interaction capability. @module */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** A provider identifier that never crosses into model-visible input. */
export type InteractionProviderId = Branded<'InteractionProviderId'>

/** Create a provider identifier at the configuration/provider boundary. */
export function interactionProviderId(value: string): InteractionProviderId {
  if (value.trim().length === 0) throw new Error('interaction provider id must be non-empty')
  return brandString<InteractionProviderId>(value)
}

/** Interaction domains supported by the stable DSH surface. */
export type InteractionDomain = 'browser' | 'desktop'

/** Normalized browser actions shared by all browser adapters. */
export type BrowserOperation =
  | { domain: 'browser'; method: 'navigate'; tabId?: string; url: string }
  | { domain: 'browser'; method: 'tabs'; operation: 'list' | 'new' | 'select' | 'close'; tabId?: string; url?: string }
  | { domain: 'browser'; method: 'observe'; tabId?: string; instruction?: string }
  | { domain: 'browser'; method: 'act'; tabId?: string; action: JsonValue }
  | { domain: 'browser'; method: 'extract'; tabId?: string; instruction: string; schema?: JsonValue }
  | { domain: 'browser'; method: 'screenshot'; tabId?: string }

/** Normalized desktop actions shared by all desktop adapters. */
export type DesktopOperation =
  | { domain: 'desktop'; method: 'observe'; applicationId?: string; windowId?: string }
  | { domain: 'desktop'; method: 'act'; applicationId?: string; windowId?: string; action: JsonValue }
  | { domain: 'desktop'; method: 'screenshot'; applicationId?: string; windowId?: string }

/** One model-facing interaction operation. */
export type InteractionOperation = BrowserOperation | DesktopOperation

/** Provider-neutral state shown by Host setup and capability surfaces. */
export type InteractionAvailability = 'ready' | 'needs_permission' | 'needs_configuration' | 'unavailable'

/** Provider metadata safe to expose to Host UI, never to the model. */
export interface InteractionProviderDescription {
  /** Stable provider id for diagnostics and setup routing. */
  readonly id: InteractionProviderId
  /** Domains this provider can execute. */
  readonly domains: readonly InteractionDomain[]
  /** Normalized operation methods supported by this provider. */
  readonly methods?: readonly string[]
  /** Current setup/permission state. */
  readonly availability: InteractionAvailability
  /** Human-readable diagnostic owned by the provider. */
  readonly detail?: string
}

/** An Agent-owned live interaction resource. */
export interface InteractionSession {
  /** Execute a normalized operation and return detached JSON-safe data. */
  execute(operation: InteractionOperation, signal: AbortSignal): Promise<JsonValue>
  /** Stop admission and close provider resources. */
  close(): Promise<void>
}

/** Provider adapter registered by browser or desktop implementations. */
export interface InteractionProvider {
  /** Provider metadata and capability availability. */
  describe(): InteractionProviderDescription
  /** Domain supplied by this registration. */
  readonly domain: InteractionDomain
  /** Open one live Agent-owned resource. */
  open(agent: Agent, signal: AbortSignal): Promise<InteractionSession>
}

interface Entry {
  readonly controller: AbortController
  readonly ready: Promise<InteractionSession>
  tail: Promise<void>
  closing?: Promise<void>
}

interface Registration {
  readonly provider: InteractionProvider
  readonly entries: Map<Agent, Entry>
  disposing?: Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context { interaction: InteractionService }
}

/** Owns one provider per interaction domain and exact-Agent live resources. */
export class InteractionService extends Service {
  private readonly registrations = new Map<InteractionDomain, Registration>()

  constructor(ctx: Context) { super(ctx, 'interaction') }

  /**
   * Return the active provider description for one domain, if registered.
   * @param domain - interaction domain to inspect.
   * @returns provider metadata, or undefined when no provider is registered.
   */
  describe(domain: InteractionDomain): InteractionProviderDescription | undefined {
    return this.registrations.get(domain)?.provider.describe()
  }

  /**
   * Whether an exact live Agent can use a domain in the current step.
   * @param agent - live Agent requesting the capability.
   * @param domain - interaction domain to check.
   * @param method - optional normalized operation method to check.
   * @returns true when a ready provider supports the method for this Agent.
   */
  available(agent: Agent, domain: InteractionDomain, method?: string): boolean {
    const registration = this.registrations.get(domain)
    return registration !== undefined
      && registration.disposing === undefined
      && registration.provider.describe().availability === 'ready'
      && (method === undefined || registration.provider.describe().methods?.includes(method) === true)
      && this.ctx.get('agents')?.get(agent.id) === agent
  }

  /**
   * Register one provider for a domain until its disposer completes.
   * @param provider - provider adapter owned by the registering plugin.
   * @returns disposer for this exact provider registration.
   */
  register(provider: InteractionProvider): () => Promise<void> {
    if (this.registrations.has(provider.domain)) {
      throw new Error(`interaction ${provider.domain} provider is already registered`)
    }
    const registration: Registration = { provider, entries: new Map() }
    this.registrations.set(provider.domain, registration)
    return async () => {
      if (registration.disposing !== undefined) return registration.disposing
      registration.disposing = Promise.resolve().then(async () => {
        const settled = await Promise.allSettled(
          [...registration.entries].map(([agent, entry]) => this.closeEntry(registration, agent, entry)),
        )
        const errors: unknown[] = []
        for (const result of settled) if (result.status === 'rejected') errors.push(result.reason)
        if (errors.length > 0) throw new AggregateError(errors, `interaction ${provider.domain} cleanup failed`)
        if (this.registrations.get(provider.domain) === registration) this.registrations.delete(provider.domain)
      })
      return registration.disposing
    }
  }

  /**
   * Run one operation through the exact Agent's serialized provider session.
   * @param agent - live Agent that owns the operation.
   * @param domain - operation domain.
   * @param operation - normalized operation.
   * @param signal - caller cancellation.
   * @returns detached provider result.
   */
  async run(agent: Agent, domain: InteractionDomain, operation: InteractionOperation, signal: AbortSignal): Promise<JsonValue> {
    signal.throwIfAborted()
    const registration = this.registrations.get(domain)
    if (registration === undefined || registration.provider.describe().availability !== 'ready') {
      throw new Error(`interaction ${domain} is unavailable`)
    }
    if (this.ctx.get('agents')?.get(agent.id) !== agent) throw new Error(`interaction ${domain} requires a live Agent`)
    const entry = this.entry(registration, agent)
    const combined = AbortSignal.any([signal, entry.controller.signal])
    const task = entry.tail.then(async () => {
      combined.throwIfAborted()
      const session = await entry.ready
      combined.throwIfAborted()
      const result = await session.execute(operation, combined)
      combined.throwIfAborted()
      return result
    })
    entry.tail = task.then(() => {}, () => {})
    return task
  }

  private entry(registration: Registration, agent: Agent): Entry {
    const current = registration.entries.get(agent)
    if (current !== undefined) return current
    const controller = new AbortController()
    const entry: Entry = {
      controller,
      ready: Promise.resolve().then(() => registration.provider.open(agent, controller.signal)).catch((error: unknown) => {
        registration.entries.delete(agent)
        throw error
      }),
      tail: Promise.resolve(),
    }
    void entry.ready.catch(() => {})
    registration.entries.set(agent, entry)
    const ownerCleanup = agent.ctx.effect(() => async () => {
      await this.closeEntry(registration, agent, entry)
    }, `interaction.${registration.provider.domain}.agent`)
    void ownerCleanup
    return entry
  }

  private closeEntry(registration: Registration, agent: Agent, entry: Entry): Promise<void> {
    return entry.closing ??= Promise.resolve().then(async () => {
      entry.controller.abort(new Error(`interaction ${registration.provider.domain} session is closing`))
      const session = await entry.ready.catch(() => undefined)
      try { await session?.close() } finally {
        await entry.tail
        registration.entries.delete(agent)
      }
    })
  }
}

export default InteractionService
