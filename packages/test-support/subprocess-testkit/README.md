---
description: "Mount the local subprocess runtime on its process-group path in tests whose subject is not process containment."
kind: "package-library"
---

# @deepseek-ai/dsh-subprocess-testkit

English | [中文](README.zh.md)

## Summary

Use this package in tests that run many real commands (`git`, `rg`) through `LocalSubprocessRuntime` for a subject other than process containment. On Linux the runtime wraps every spawn in a transient systemd scope, which costs about 95 ms per spawn with a warm tsx cache and 236 ms with a cold one; the helper makes the runtime take the cheaper process-group path macOS ships, and the commands still run as real processes. Callers own the Cordis context, plugin composition, and teardown.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Add `@deepseek-ai/dsh-subprocess-testkit` to the consuming package's `devDependencies`. Mount `LocalSubprocessRuntime`, then call the helper before the first spawn:

```ts
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { useProcessGroupContainment } from '@deepseek-ai/dsh-subprocess-testkit'

const ctx = new Context()
await ctx.plugin(LocalSubprocessRuntime)
useProcessGroupContainment(ctx)
```

The helper throws when the composition mounts a different subprocess provider. Do not use it in specs whose subject is process containment, signalling, background jobs, terminals, or sandboxing, or in end-to-end and performance files: those keep the real scope.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`src/index.ts`](src/index.ts) sets the runtime's `internals.platform` test hook to `darwin` on Linux, which is the runtime's only containment-selection seam. The hook also steers the process-group owner: it skips the Linux `/proc` group-member probe and decides liveness from signal 0 on the group alone, so descendants that outlive the direct child are observed through the group instead of through a Linux member scan. Existing `internals` fields are kept. The helper changes no product configuration and does nothing on other platforms.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Local subprocess runtime](../../subprocess/subprocess-local/README.md) — containment modes and their per-spawn costs.
- [Testing policy](../../../docs/testing.md) — choosing verification for production behavior.
- [Test-support group map](../README.md) — sibling test utilities.

-----

<a id="model-experience"></a>
## Model Experience

None, as these test helpers do not assemble or send model requests.

#### KV Cache effect

None; the package itself sends no provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Specs that use the helper no longer exercise real scopes; `subprocess-local` keeps the native-containment specs.
- The helper reaches the process-group path through a platform override, not a named option; a named containment option in the runtime would replace it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
