---
description: "Inspect immutable Fusion model selections and exact provider metadata without sending an inference request."
kind: "package-reference"
---

# @deepseek-ai/dsh-fusion-config

English | [中文](README.zh.md)

## Summary

Inspect a named Fusion configuration with `/fusion_preflight <selection>` before using a model. Exact identities, efforts and lineage are captured by value; an advertised model alone cannot establish effort support. Configuration readiness, live integration coverage and default eligibility are separate results. This opt-in package initializes no Script or collaboration runtime and changes no shipped profile.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

### When to choose it

Use this package for non-inference configuration inspection. Keep ordinary DSH model setup for stock sessions. The Loader must already supply `llm`, `credentials`, `commands` and `agentPresets`; this package owns only the explicitly declared provider routes, which must not also be registered by another adapter instance.

### Minimal configuration

Insert the following row in an explicit profile overlay. In a source checkout, use the absolute path to this package's built `lib/index.js` as `name` if the profile's resolver does not include the package. Launch the existing DSH CLI with `dsh --profile sdk --patch /absolute/path/fusion.patch.yml`, then invoke `/fusion_preflight top` through the profile's human command interface. Nothing becomes a persistent default. The SDK overlay explicitly admits this command definition; stock SDK text routing admits only its builtin commands. Omit the preset-registry rows if that service and a suitable preset already exist. The empty inspection preset composes no task tools. On the SDK profile, the credentials row enables the existing local credential provider only for this explicit overlay; preflight with empty providers never reads it. See the keyless snapshot for a fake credential provider instead.

```yaml
- id: sdk-jsonrpc-server
  config:
    queryCommandDefinitions:
      - '@deepseek-ai/dsh-fusion-config/preflight'
- id: credentials
  disabled: false
- insert:
    - name: '@deepseek-ai/dsh-agent-preset-registry'
      config:
        default: fusion-inspection
    - name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: fusion-inspection
        plugins: []
    - name: '@deepseek-ai/dsh-fusion-config'
      config:
        document:
          credentialRef: OMNIROUTE_API_KEY
          agentPreset: fusion-inspection
          providers: {}
          declarations: []
          bindings: []
          selections: []
          metadataLimits:
            responseBytes: 1048576
            totalBytes: 16777216
            pages: 128
            timeoutMs: 30000
```

This minimal row reports blocked provider configuration without contacting the network or resolving credentials. `agentPreset` must name an existing DSH preset. The named shipping choices are `top`, `top-opus`, `middle`, `middle-fable-terra`, `low` and `low-opus-luna`. Their pairings and upgrade chains are fixed declarations; selecting a name inspects it without admitting a task.

| Document field | Requirement |
|---|---|
| `credentialRef` | Host credential reference used to materialize the shipping catalog; never the value |
| `agentPreset` | Existing capability composition for shipping choices |
| `providers` | Explicit pi-ai profiles keyed by provider id; empty is blocked, not an inferred route |
| `declarations` | Exact provider/wire-id declarations with `tools`, `structuredDecisions` and supported `efforts`; absent evidence blocks |
| `bindings` | Additional exact model declarations under new catalog revisions; reserved revisions cannot be overwritten |
| `selections` | Additional unique names with explicit selection revision, agent preset, topology and auxiliary map |
| `metadataLimits` | Positive response-byte, total-byte, page-count and millisecond bounds |

Provider profiles require `api` (`openai-responses` or `anthropic-messages`), `baseURL`, `apiKeyEnv`, `transport: sse` and an explicit `models` list. Models accept exact `id`, optional `reasoningEfforts` mapping low/medium/high to the same explicit wire values, and optional `compat.forceAdaptiveThinking`. Inline credentials, extra headers, automatic transports and unsupported protocols are rejected. Profile resolution uses the existing pi-ai configuration validator and adapter. Anthropic effort requires the materialized model's explicit adaptive-thinking support; a `cc/` alias or a reasoning-level map alone is insufficient. Configure these facts only from adapter and route evidence; the example does not declare any route supported.

A selection's topology is `top` with two `coLeads` and an `executor`, `middle` or `low` with `lead`, `executor` and ordered `upgrades`, or `single` with `participant`. Each reference contains `catalogRevision` and `presetId`; optional `effort` must equal that catalog's role effort. Optional `decider` and `takeover` are separate lead-effort roles; deciders may share a participant's family. `auxiliaries` maps explicit role names to references. Every reference resolves at load, including unselected upgrade and auxiliary roles. Known canonical identities cannot be relabeled, and aliases require an exact canonical mapping. Custom routes use new catalog revisions.

### Reading results

`selection(id)` returns a deeply frozen, fully materialized role map without I/O. `preflight(id, signal?)` checks the preset, registered pi-ai adapter, exact transport/base URL/credential reference, explicit capabilities and effort, current credential resolution, then complete exact-ID metadata membership. The command records its result through ordinary `command/run` and `command/done` events; it suppresses raw command input and never records credentials or provider error bodies. Fix the reported configuration or metadata problem and rerun the command. Reports never imply inference availability, backend identity or runtime safety.

`structural: ready` means the non-inference checks passed. Coverage remains `live-unverified`, `defaultEligible` remains false, and `productAdmission` remains unavailable until downstream runtime safety checks exist. Missing provider capability metadata is retained as absent in the sanitized receipt even when explicit configuration establishes structural readiness. Conflicting available metadata blocks the binding.

## Understand the implementation

The service captures all selections before publishing its command or providers. Existing preset resolution owns capability composition, existing credentials own secret resolution, and the existing LLM registry and pi-ai adapter own model parameter validation. This package's metadata reader uses only authenticated GET requests, disables redirects, follows advertised same-origin continuations and cancels response readers after complete or failed traversal. A selected id on an incomplete listing remains unknown. Receipts contain host, endpoint, retrieval time, selected id, page/byte counts and a sorted distinct-id SHA-256 digest, without unrelated model records. Plugin disposal aborts and awaits its preflights and withdraws its command and provider registrations.

## Further Exploration

- [Agent presets](../agent-preset-registry/README.md) — capability composition and retained revisions.
- [pi-ai adapter](../../llm/llm-pi-ai/README.md) — transport and effort declarations.
- [Credentials](../../credentials/credentials/README.md) — references and provider-owned values.
- [Tests](tests/fixtures/cordis.yml) — reproducible keyless Loader composition, also used without this plugin for stock isolation checks.

## Dev Note

Provider profiles are intentionally owned by this opt-in consumer, avoiding a change to ordinary pi-ai discovery. Do not mount duplicate provider ids elsewhere. Tests supply only sentinel credentials and loopback fake metadata servers; no inferred capability, real credential source or synthetic inference probe is part of preflight.

## Model Experience

### Preflight command

#### What the model sees

`/fusion_preflight <selection>` results return directly to the human through command lifecycle events. No model request, tool input or Script context receives the selection or credential.

#### Token effect

Preflight sends zero inference requests. Metadata GETs and configuration reads do not consume model tokens.

#### KV Cache effect

Inspection adds no model-visible input or runtime context and initializes no Script heap.

## Known Limitations and Deferred Work

- **Task admission and collaboration** — this service supplies captured configuration and non-inference reports only. Runtime safety, checkpoint capture, takeover authorization, recovery and execution belong to downstream integration.
- **Live evidence and eligibility** — no live route integration or benchmark evidence is collected or inherited. Ordinary successful use cannot enable a default through this service.
- **Metadata dialects** — supported listings use `data` with exact string ids and explicit URL continuations or Anthropic `has_more`/`last_id` cursors. Unsupported or malformed pagination blocks traversal; it cannot establish absence.
- **Configuration durability** — the Loader owns configuration files. This package does not write task records or retain a historical catalog database; callers retain captured selections, and edited identities require new revisions.
