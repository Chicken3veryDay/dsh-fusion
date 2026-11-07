---
kind: upgrade-guide
description: Shipped profiles replace direct model tool calls with Node PTC run_code programs by default.
---

# Script execution by default

English | [中文](guide.zh.md)

## Change

All shipped profiles, including `sdk-minimal`, expose `run_code` by default. Models call registered tools through generated `tools.<name>(...)` program bindings. Native tool calling requires an explicit executor selection. Existing native-call history remains readable when resuming; the selected executor governs new calls. The saved Web `ptc` preset ID remains supported and inherits the deployment executor.

A program that requests a wider sandbox mode needs one approval, with one justification, before it starts; that grant covers the one execution. Nested tools keep their own policies and approvals, so a nested call can still ask for approval, and the grant does not change the standing Session policy. ACP emits nested `tool_call` and `tool_call_update` updates with the sub-call `toolCallId` and `_meta["dsh/parentToolCallId"]` naming the program. Headless `--json` emits nested `tool_call` and `tool_result` events with the sub-call `callId` and a `parentCallId`. Both retain the outer `run_code` lifecycle. Session logs persist nested activity as `tool/ptc-dispatch-start` and `tool/ptc-dispatch`. Web produced-file and created-task Turn data, Forge change-request bindings, and action cards include nested calls; `propose_action` accepts a call from a program and no longer refuses it with `Call propose_action directly, not from code.`

## Migration

1. Update prompts and model integrations to call `run_code` using the generated program bindings. Await asynchronous work and tool calls; only printed values and the program completion become output.
2. Update ACP consumers to correlate nested updates through `_meta["dsh/parentToolCallId"]`, and headless JSON consumers through `parentCallId`. Confirm a tool-using turn records both the outer call and nested dispatches.
3. To retain direct native tool calling, save this patch as `native.yml` and pass `--patch ./native.yml`, or its path through the TypeScript or Python SDK `patches` option:

```yaml
- id: tool-executor-native
  disabled: false
- id: tool-executor-ptc
  disabled: true
```

4. For a single preset or subagent scope, mount `@deepseek-ai/dsh-tool-executor-native` within that scope instead. See [native executor configuration](../../../../packages/core/tool-executor-native/README.md#use-this-package). Confirm the selected scope advertises direct tool schemas while other scopes still advertise `run_code`.
