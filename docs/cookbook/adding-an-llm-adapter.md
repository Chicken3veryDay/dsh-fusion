# Cookbook: adding an LLM adapter

English | [中文](adding-an-llm-adapter.zh.md)

How to connect a new model provider. Reference implementations: `packages/llm/llm-deepseek` (direct HTTP, SSE framed by `eventsource-parser`) and `packages/llm/llm-pi-ai` (wrapping an LLM library). Read the `StreamChunk` doc in `packages/llm/llm/src/types.ts` first — it records the protocol conventions both adapters were verified against.

## The shape

```ts ignore-check
class MyAdapter extends LlmAdapter {
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> { … }
}

export const name = 'llm-myprovider'
export const inject = ['llm']
export const Config: z<Config> = z.object({ apiKey: z.string(), … })

export function apply(ctx: Context, config: Config) {
  ctx.llm.registerAdapter(['my-provider'], new MyAdapter(…))
}
```

Registration is effect-based (HMR-safe); one adapter per provider route — duplicates throw, and multi-route registration is all-or-nothing. `options.provider` selects the adapter and `options.model` is the provider model id, so a dynamic catalog adapter can serve new models without lifecycle reconfiguration. Secrets are cordis-native: schemastery Config with env fallbacks, fed from cordis.yml via `!!js process.env.MY_KEY`. Never read ad-hoc key files in code.

## Protocol obligations (the contract two implementations verified)

- Emit `usage` BEFORE `finish`; emit NOTHING after `finish`. The robust way: buffer finish/usage until the provider's end-of-stream marker, then flush (handles providers that send trailing usage-only chunks).
- Tool-call `arguments` are RAW JSON strings end-to-end; stream fragments as `argumentsDelta`. If your provider hands back parsed objects, re-stringify at `block-end`.
- Allocate block `index`es in first-seen stream order; reuse the index for every delta of the same block.
- Errors have exactly two sanctioned paths: THROW from `stream()` (transport and protocol failures — use `LlmError` with a stable code), or end the stream with `finish {kind: 'error' | 'aborted'}` (provider in-band failures). Consumers handle both; pick per failure class and document it.
- Honor `options.signal` (pass it to fetch / your SDK).
- A request control your provider cannot honor (e.g. a `stop` list on a provider without stop sequences): return `{ kind: 'unsupported', reason }` for it from the synchronous, pure `assessControls()` of your `PreparedAdapterCall`, and build the result with `assessSuppliedControls()` so every supplied control gets a verdict. The runtime then fails the call with `LlmError` code `UNSUPPORTED_CONTROL` before any credential or network work. When your current connection facts alone prove a control unsupported, such as the origin and reasoning mode of a provider that ignores it, you may also override the optional synchronous, pure `preassessControls(provider, model, controls)` on the adapter: the runtime calls it once before `prepareCall()` for a call without a `ConfigureCall` and an unprepared stream, shows it only the supplied control fields, and lets only an `unsupported` verdict act. Return `undefined` for everything else; the captured generation still assesses accepted calls and a call with a `ConfigureCall` skips the hook. Return `translated` when you send a different wire value. When your serializer lowers or caps a supplied value by conditions only known at serialization (a model output ceiling, a context-window clamp), attach `constraints` to the `supported` or `translated` verdict instead of computing a payload value early. Return `unverified` when captured facts cannot establish support; never omit a supplied control. Any other `GenerateOptions` field you cannot honor: throw `LlmError(..., 'UNSUPPORTED_OPTION')` rather than silently dropping it. If a verdict depends on authentication, implement optional `finalizeControls(controls, signal)` after the pure step. Return detached final verdicts plus a dispatch bound to the same effective authentication. Honor cancellation promptly, discard late results, and never contribute headers or send inference while finalizing. When the request-error hook owns transient authentication recovery, pin the failed resolution in the returned stream with honest unverified verdicts. Raise the original failure from that stream without another lookup. Keep policy refusals and cancellation before admission; do not catch arbitrary configuration callback errors.
- If the provider requires response ids, signatures, or other native metadata on follow-up calls, emit the minimal lossless-JSON projection as `finish.replayState`. Validate it when rebuilding history. `LlmRuntime` passes it only when the historical provider route and target provider route are currently owned by the exact same adapter instance; your adapter decides whether same-model, cross-model, or cross-provider restoration is legal. Never infer native replay from provider/model names alone when state is absent.

Provider-specific thinking-mode toggles remain in the adapter's Config. Exact model metadata uses one provider-neutral capability seam: implement `resolveModel()` with provider/model identity and optional `context` and `reasoning` fields, declare a configured `defaultEffort` only when one exists, and honor the resolver's optional `AbortSignal`. Reasoning efforts are ordered opaque ids mapped to provider requests by the adapter. Preserve the adapter's authoritative selectable list, including an adapter-defined `off` when supported, without exposing final wire spellings or clamping unsupported values; an id need not equal its wire representation.

## Implementation structure

Keep wire types, request serialization, transport parsing, chunk translation, and the adapter class as separate responsibilities; [`llm-deepseek`](../../packages/llm/llm-deepseek/README.md) is the reference layout.

## Verification

Follow the [repository testing policy](../testing.md), which owns adapter coverage, real-provider checks, and published-entry requirements.
