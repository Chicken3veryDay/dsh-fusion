---
kind: upgrade-guide
description: 随附 profile 默认使用 Node PTC run_code 程序替代模型直接工具调用。
---

# 默认使用 Script 执行

[English](guide.md) | 中文

## 变更

所有随附 profile（包括 `sdk-minimal`）默认提供 `run_code`。模型通过生成的 `tools.<name>(...)` 程序绑定调用已注册工具。原生工具调用需要显式选择执行器。恢复时仍可读取已有的原生调用历史；选定执行器只控制新调用。已保存的 Web `ptc` preset ID 仍受支持，并继承部署执行器。

审批以整个程序及其一份理由为单位，而非每条嵌套命令。ACP 发出嵌套的 `tool_call` 和 `tool_call_update` 更新，以子调用 `toolCallId` 为标识，并由 `_meta["dsh/parentToolCallId"]` 指向程序。Headless `--json` 发出嵌套的 `tool_call` 和 `tool_result` 事件，包含子调用 `callId` 与 `parentCallId`。两者都保留外层 `run_code` 生命周期。Session 日志以 `tool/ptc-dispatch-start` 和 `tool/ptc-dispatch` 持久化嵌套活动。

## 迁移

1. 更新提示词和模型集成，使用生成的程序绑定调用 `run_code`。等待异步工作和工具调用；只有打印值和程序完成值会成为输出。
2. 更新 ACP 消费方，通过 `_meta["dsh/parentToolCallId"]` 关联嵌套更新；headless JSON 消费方则使用 `parentCallId`。确认使用工具的轮次同时记录外层调用与嵌套分派。
3. 如需保留直接原生工具调用，将此补丁保存为 `native.yml` 并传入 `--patch ./native.yml`，或通过 TypeScript 或 Python SDK 的 `patches` 选项传入路径：

```yaml
- id: tool-executor-native
  disabled: false
- id: tool-executor-ptc
  disabled: true
```

4. 如需仅覆盖一个 preset 或子代理作用域，在该作用域内挂载 `@deepseek-ai/dsh-tool-executor-native`。参见[原生执行器配置](../../../../packages/core/tool-executor-native/README.zh.md#use-this-package)。确认选定作用域公布直接工具 schema，其他作用域仍公布 `run_code`。
