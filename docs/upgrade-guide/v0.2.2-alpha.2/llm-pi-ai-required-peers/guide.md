---
kind: upgrade-guide
description: "`@deepseek-ai/dsh-llm-pi-ai` requires the `@deepseek-ai/dsh-agent` and `@deepseek-ai/dsh-credentials-local` peers."
---

# Two more required peers for `dsh-llm-pi-ai`

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-llm-pi-ai` adds `@deepseek-ai/dsh-agent` and `@deepseek-ai/dsh-credentials-local` to its required `peerDependencies`. The plugin imports `dsh-credentials-local` when it loads, including for profiles without `accounts`, and uses `dsh-agent` for the agent request-error event types.

Installs through the `dsh` profiles already include both packages and need no action. A consumer that installs the plugin's peers itself, such as a custom host, an SDK runtime, or a package manager that does not install peers automatically, now fails at install or load until both packages resolve. The new `accounts` profile key is optional and changes no existing profile.

## Migration

1. Add `@deepseek-ai/dsh-agent` and `@deepseek-ai/dsh-credentials-local` to the host's dependencies, at the same version as your other `@deepseek-ai/dsh-*` packages.
2. Reinstall and confirm that the package manager reports no missing peer for `@deepseek-ai/dsh-llm-pi-ai`.
3. Start the host and confirm that the `llm-pi-ai` plugin loads without a module-not-found error.
