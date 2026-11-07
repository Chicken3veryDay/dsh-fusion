---
kind: upgrade-guide
description: "SDK slash queries reject unavailable command definitions configured by overlays."
---

# SDK query command definitions

English | [中文](guide.zh.md)

## Change

SDK deployments with explicit `queryCommandDefinitions` reject slash queries when any configured definition is missing from the receiving Agent’s command registry, including scoped replacements. Previously these queries could become ordinary model prompts. An absent commands service also rejects slash queries when additional definitions are configured. Ordinary non-slash prompts and deployments using the default empty list retain their behavior.

## Migration

1. Check `queryCommandDefinitions` in SDK profile overlays against the command definition ids supplied by the loaded plugins.
2. Load missing command plugins or remove unavailable ids. Ensure scoped replacements retain the intended definition id.
3. Submit the intended slash command and confirm a command result without an ordinary model request; a configuration error names the missing definition or service.
