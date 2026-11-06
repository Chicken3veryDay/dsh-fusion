---
description: "Enable the Context Index, the context tree, and its browse and load tools with one experimental profile layer that keeps the eager instruction core small."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-context-profile

English | [中文](README.zh.md)

## Summary

`dsh-experimental-context-profile` mounts the [Context Index](../context-index/README.md) and the [context tree](../context-tree/README.md), registers the `context_browse` and `context_load` model tools, and caps the eagerly loaded instruction files at 4096 bytes per chain. Every tool outside the base set stays hidden until the model loads it, and loaded material is revoked at compaction. The layer ships unlisted and is added only to an initialized profile.

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

The patch sets `maxBytes: 4096` on the `agent-instructions` entry and inserts three entries:

| Entry | Package | Role |
|---|---|---|
| `context-index` | `@deepseek-ai/dsh-experimental-context-index` | sections of instruction and documentation files |
| `context-tree` | `@deepseek-ai/dsh-experimental-context-tree` | tree, tool admission, revocable grants |
| `tool-context-tree` | `@deepseek-ai/dsh-experimental-context-profile/context-tree-tools` | registers `context_browse` and `context_load` |

Defaults of the tree, including the base tool list, are documented in the [context tree README](../context-tree/README.md#use-this-package). Change them with a `config:` patch on the `context-tree` entry.

<a id="understand-the-implementation"></a>
## Understand the implementation

- [`cordis.patch.yml`](cordis.patch.yml) is the layer.
- [`src/context-tree-tools.ts`](src/context-tree-tools.ts) re-exports `ContextTreeTools` as a default export, because the Loader mounts only a default export.
- [`src/index.ts`](src/index.ts) is empty; the package carries no runtime of its own.

[`tests/composition.spec.ts`](tests/composition.spec.ts) boots a `dsh` process through the Loader with a keyless scripted model. It asserts that a hidden tool is absent from the first request, declared in the request after `context_load`, and absent again after compaction, and that the catalog and activation messages are in the persisted Session log. A control run without the layer sees every tool from the first request.

<a id="model-experience"></a>
## Model Experience

### Context tree tools and hidden tools

#### What the model sees

The `context_browse` and `context_load` schemas, the catalog message, and, after a load, grant and activation messages, all described in the [context tree Model Experience](../context-tree/README.md#model-experience). The layer adds no text of its own. Tools outside the base set are not declared until loaded.

#### Token effect

The layer removes every non-base tool schema from each request and adds the two tree schemas and the catalog. The 4096-byte instruction cap shortens the eager instruction text; the omitted part stays reachable through `Instructions` in the tree.

#### KV Cache effect

The tool list and the system prompt are prefix-stable while the patch and the loaded set are unchanged. Loading a tool changes the declared tool list from the tool's registration position on; compaction replaces earlier request tokens as it always does.

## Known Limitations and Deferred Work

- **Opt-in only** — no shipped CLI, Web, SDK, ACP, or Python profile enables it.
- **Coarse eager core** — `agent-instructions` has no section selection, so the layer caps the whole text of each instruction chain at 4096 bytes with an omission marker. A curated small core needs a change to that package.
- **Base profile required** — the patch depends on services supplied by `dsh-base`.
- **Tool origins** — see the [context tree limitations](../context-tree/README.md#known-limitations-and-deferred-work); every tool is under `Tools/Global`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
