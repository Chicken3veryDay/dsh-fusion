---
kind: upgrade-guide
description: Shipped profiles replace direct model tool calls with Node PTC run_code programs by default.
---

# Script execution by default

English | [中文](guide.zh.md)

## Change

All shipped profiles, including `sdk-minimal`, expose `run_code` by default. Models call registered tools through generated `tools.<name>(...)` program bindings. Native tool calling requires an explicit executor selection. Existing native-call history remains readable when resuming; the selected executor governs new calls. The saved Web `ptc` preset ID remains supported and inherits the deployment executor.

Approval covers the whole program, with one justification, rather than each nested command. ACP and headless expose the outer `run_code` call; nested tool activity is persisted as `tool/ptc-dispatch-start` and `tool/ptc-dispatch`. Consumers that inspect direct tool names must handle those events.

## Migration

1. Update prompts and model integrations to call `run_code` using the generated program bindings. Await asynchronous work and tool calls; only printed values and the program completion become output.
2. Update protocol consumers to recognize `run_code` and correlate nested dispatches by their parent call ID. Confirm a tool-using turn records both the outer call and nested dispatches.
3. To retain direct native tool calling, save this patch as `native.yml` and pass `--patch ./native.yml`, or its path through the TypeScript or Python SDK `patches` option:

```yaml
- id: tool-executor-native
  disabled: false
- id: tool-executor-ptc
  disabled: true
```

4. For a single preset or subagent scope, mount `@deepseek-ai/dsh-tool-executor-native` within that scope instead. See [native executor configuration](../../../../packages/core/tool-executor-native/README.md#use-this-package). Confirm the selected scope advertises direct tool schemas while other scopes still advertise `run_code`.
