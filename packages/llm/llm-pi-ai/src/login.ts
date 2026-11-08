/**
 * Authorization flows for the pi-ai providers that ship a login. This is the
 * whole of the translation between the harness's neutral notice/prompt
 * vocabulary and pi-ai's `AuthInteraction`; nothing above it knows which
 * library ran the conversation.
 *
 * @module dsh-llm-pi-ai/login
 */

import type { AuthEvent, AuthInteraction, AuthPrompt, AuthType, Provider } from '@earendil-works/pi-ai'
import type { Context } from '@deepseek-ai/cordis'
import type { AuthorizationMethod, AuthorizationPrompt, AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { isCredentialKeySegment } from '@deepseek-ai/dsh-credentials'
import { catalogProvider, catalogProviderIds } from './catalog.ts'
import { installationDeviceId, recordKeyFor } from './auth.ts'
import type { PiAiAuthInjection } from './adapter.ts'
import { createModels } from './models.ts'

/**
 * Catalog providers whose OAuth login identifies the installation to the
 * vendor. pi-ai's Sign in with ChatGPT (`openai`) sends a stable UUID that the
 * app supplies through `LoginOptions.getDeviceId` and refuses to start without
 * one; the harness supplies {@link installationDeviceId}, resolved before the
 * login starts because pi-ai reads it synchronously. Other providers never get
 * an id, so signing into them does not create one.
 */
const DEVICE_ID_OAUTH: ReadonlySet<string> = new Set(['openai'])

/**
 * The login methods one catalog provider offers.
 *
 * Anthropic sign-in offers subscription OAuth only; API-key routes remain
 * explicit configuration. Other methods appear when pi-ai can run them: `oauth` carries a
 * `login` that runs with the login options this module supplies, while an
 * api-key method has one only when the provider collects its key interactively
 * — which every installed one currently does, so a key is typed into pi-ai's
 * own prompt rather than into the settings form.
 * @param provider - the installed catalog provider, if pi-ai ships one.
 * @returns its methods, most preferred first; empty when it offers no login.
 */
function loginMethods(provider: Provider | undefined): AuthorizationMethod[] {
  const methods: AuthorizationMethod[] = []
  const oauth = provider?.auth.oauth
  if (oauth !== undefined) methods.push({ id: 'oauth', label: oauth.loginLabel ?? oauth.name })
  if (provider?.id === 'anthropic') return methods
  const apiKey = provider?.auth.apiKey
  if (apiKey?.login !== undefined) methods.push({ id: 'api-key', label: apiKey.name })
  return methods
}

/**
 * Restate one pi-ai login event in the seam's vocabulary.
 *
 * A device-code grant is the one event carrying two things the human needs at
 * once — where to go and what to type there — which is why the neutral notice
 * has a `code` beside its `url` rather than folding the code into the message.
 * @param event - what pi-ai reported.
 * @param session - the attempt to report it to.
 */
function relay(event: AuthEvent, session: AuthorizationSession): void {
  switch (event.type) {
    case 'info': {
      const link = event.links?.[0]
      session.notify({ message: event.message, ...link === undefined ? {} : { url: link.url } })
      return
    }
    case 'auth_url':
      session.notify({
        message: event.instructions ?? 'Open this page to continue signing in.',
        url: event.url,
      })
      return
    case 'device_code':
      session.notify({
        message: 'Enter this code on the verification page to finish signing in.',
        url: event.verificationUri,
        code: event.userCode,
      })
      return
    case 'progress':
      session.notify({ message: event.message })
      return
    default:
      // pi-ai's event union is open to new members: a build that meets one it
      // does not know still shows the human that something is happening rather
      // than going silent mid-login.
      session.notify({ message: 'Signing in…' })
  }
}

/**
 * Restate one pi-ai prompt in the seam's vocabulary.
 *
 * `manual_code` becomes a plain text question because the difference pi-ai
 * draws — a code the human copies from a browser rather than a value they know
 * — changes nothing a surface renders. Its own `signal` is carried through, and
 * that is the part which matters: it is how a flow racing a typed code against
 * a browser callback withdraws the losing question.
 * @param prompt - what pi-ai asked.
 * @returns the neutral prompt to put to the human.
 */
function restate(prompt: AuthPrompt): AuthorizationPrompt {
  const signal = prompt.signal === undefined ? {} : { signal: prompt.signal }
  switch (prompt.type) {
    case 'select':
      return { ...signal, kind: 'select', message: prompt.message, options: prompt.options }
    case 'secret':
      return {
        ...signal,
        kind: 'secret',
        message: prompt.message,
        ...prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder },
      }
    default:
      return {
        ...signal,
        kind: 'text',
        message: prompt.message,
        ...prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder },
      }
  }
}

/**
 * Register one authorization flow per installed provider that ships a login.
 *
 * Registration is unconditional on configuration: a provider has to be signed
 * into before a route for it is worth adding, so the flow exists from the
 * moment the plugin mounts rather than appearing once a profile does.
 * @param ctx - the plugin context carrying `ctx.authorization`.
 * @param auth - the injectables every collection here is built with.
 */
export function registerPiAiFlows(ctx: Context, auth: PiAiAuthInjection): void {
  for (const providerId of catalogProviderIds()) {
    const provider = catalogProvider(providerId)
    const [first, ...rest] = loginMethods(provider)
    /* v8 ignore next 3 -- every id here names an installed provider and every
       installed provider ships a login, so no entry is skipped; the guard
       is what keeps that from becoming a crash if either stops being true. */
    if (provider === undefined || first === undefined) continue
    /* v8 ignore next 7 -- every installed catalog id is a lowercase
       hyphenated identifier; the guard keeps a future upstream id outside the
       record grammar (dotted or uppercase, as vendor ids elsewhere already
       are) from throwing in `recordKeyFor` and failing the whole mount. */
    if (!isCredentialKeySegment(providerId)) {
      ctx.logger.warn(
        'llm-pi-ai: catalog provider "%s" cannot address a credential record; its sign-in is not offered',
        providerId)
      continue
    }
    ctx.authorization.registerFlow({
      key: recordKeyFor(providerId),
      label: provider.name,
      methods: [first, ...rest],
      async run(session) {
        // A collection of its own, holding only the provider being signed
        // into: login is not serving requests, and the credential it produces
        // lands in the shared store either way.
        const models = createModels(auth)
        models.setProvider(provider)
        // Total over the two ids declared above, and the seam only ever hands
        // back one a flow declared.
        const type: AuthType = session.method === 'oauth' ? 'oauth' : 'api_key'
        // pi-ai persists what the login returns through that same store, which
        // is what makes it the single writer of this record.
        const interaction: AuthInteraction = {
          signal: session.signal,
          notify: (event) => { relay(event, session) },
          prompt: prompt => session.prompt(restate(prompt)),
        }
        if (type === 'oauth' && DEVICE_ID_OAUTH.has(providerId)) {
          const deviceId = await installationDeviceId(ctx)
          await models.login(providerId, type, interaction, { getDeviceId: () => deviceId })
        } else {
          await models.login(providerId, type, interaction)
        }
      },
    })
  }
}
