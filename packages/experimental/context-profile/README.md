---
description: "Enable the Context Index, the context tree, the project map with its background curator, and their tools with one experimental profile layer that keeps the eager instruction core small."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-context-profile

English | [中文](README.zh.md)

## Summary

`dsh-experimental-context-profile` mounts the [Context Index](../context-index/README.md) and the [context tree](../context-tree/README.md), registers the `context_browse` and `context_load` model tools, mounts the [project map](../context-map/README.md) with its default curator and the `context_note` tool, and caps the eagerly loaded instruction files at 4096 bytes per chain. Every tool outside the base set stays hidden until the model loads it, and loaded material is revoked at compaction. The layer ships unlisted and is added only to an initialized profile.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Install into a profile

```sh
dsh plugin --profile headless add @deepseek-ai/dsh-experimental-context-profile
dsh --profile headless "Browse the context tree and load the ticket tools."
```

The profile must already contain `@deepseek-ai/dsh-base`, whose tool, compaction, and Session services this layer consumes. `dsh plugin --profile <name> remove @deepseek-ai/dsh-experimental-context-profile` removes the layer.

### What you get

The patch sets `maxBytes: 4096` on the `agent-instructions` entry and inserts six entries:

| Entry | Package | Role |
|---|---|---|
| `context-index` | `@deepseek-ai/dsh-experimental-context-index` | sections of instruction and documentation files |
| `context-tree` | `@deepseek-ai/dsh-experimental-context-tree` | tree, tool admission, revocable grants |
| `tool-context-tree` | `@deepseek-ai/dsh-experimental-context-profile/context-tree-tools` | registers `context_browse` and `context_load` |
| `context-map` | `@deepseek-ai/dsh-experimental-context-map` | the project map and its role check |
| `tool-context-map` | `@deepseek-ai/dsh-experimental-context-profile/context-map-tools` | registers `context_note` and the curator-only map tools |
| `context-curator` | `@deepseek-ai/dsh-experimental-context-profile/context-curator` | background default curator on a cheaper route |

Defaults of the tree, including the base tool list, are documented in the [context tree README](../context-tree/README.md#use-this-package). Change them with a `config:` patch on the `context-tree` entry.

<a id="understand-the-implementation"></a>
## Understand the implementation

- [`cordis.patch.yml`](cordis.patch.yml) is the layer.
- [`src/context-tree-tools.ts`](src/context-tree-tools.ts) re-exports `ContextTreeTools` as a default export, because the Loader mounts only a default export.
- [`src/context-map-tools.ts`](src/context-map-tools.ts) and [`src/context-curator.ts`](src/context-curator.ts) do the same for `ContextMapTools` and `DefaultContextCurator`.
- [`src/index.ts`](src/index.ts) is empty; the package carries no runtime of its own.

[`tests/composition.spec.ts`](tests/composition.spec.ts) boots a `dsh` process through the Loader with a keyless scripted model. It asserts that a hidden tool is absent from the first request, declared in the request after `context_load`, and absent again after compaction, and that the catalog and activation messages are in the persisted Session log. A control run without the layer sees every tool from the first request. A second run scripts the working agent and the curator through one keyless adapter: the curator runs on the smaller model at its least effort, the Session log holds the map edits, the curator's conversation is only in its own Session, and the working agent's requests carry `context_note` but none of the curator tools.

<a id="model-experience"></a>
## Model Experience

### Context tree tools and hidden tools

#### What the model sees

The `context_browse` and `context_load` schemas, the catalog message, and, after a load, grant and activation messages, all described in the [context tree Model Experience](../context-tree/README.md#model-experience). The layer adds no text of its own. With the shipped PTC executor, only `run_code` is directly callable; admitted tools appear in `tools:sdk` and its program bindings. Tools outside the base set are absent from both until loaded for the next step, and compaction revokes both declarations and bindings. A running program retains its admitted tool set.

#### Token effect

The layer removes unloaded non-base tool declarations from each request and adds the tree and `context_note` declarations and catalog; PTC renders those declarations as a generated SDK, while native execution renders tool schemas. Map curation costs the working conversation nothing: it happens in the curator's own Session on a cheaper route. The 4096-byte instruction cap shortens the eager instruction text; the omitted part stays reachable through `Instructions` in the tree.

#### KV Cache effect

The tool list and the system prompt are prefix-stable while the patch and the loaded set are unchanged. Loading a tool changes the declared tool list from the tool's registration position on; compaction replaces earlier request tokens as it always does.

## Known Limitations and Deferred Work

- **Opt-in only** — no shipped CLI, Web, SDK, ACP, or Python profile enables it.
- **Coarse eager core** — `agent-instructions` has no section selection, so the layer caps the whole text of each instruction chain at 4096 bytes with an omission marker. A curated small core needs a change to that package.
- **Curator route** — the default curator needs a model of the working agent's provider that undercuts the working agent's route; without one it logs `CONTEXT_MAP_NO_CHEAP_ROUTE` and does not run. See the [context map limitations](../context-map/README.md#known-limitations-and-deferred-work).
- **Base profile required** — the patch depends on services supplied by `dsh-base`.
- **Tool origins** — see the [context tree limitations](../context-tree/README.md#known-limitations-and-deferred-work); every tool is under `Tools/Global`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
