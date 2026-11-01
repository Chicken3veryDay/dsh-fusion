---
description: "检查不可变的 Fusion 模型选择和精确提供方元数据，不发送推理请求。"
kind: "package-reference"
---

# @deepseek-ai/dsh-fusion-config

[English](README.md) | 中文

## 概述

使用 `/fusion_preflight <selection>` 检查具名配置。模型身份、推理力度和模型家族按值捕获；模型列表本身不能证明力度支持。配置就绪、实时集成覆盖和默认资格分别报告。此可选插件不初始化 Script 或协作运行时，也不改变任何内置配置。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [开发备注](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

### When to choose it

此插件用于不进行推理的配置检查。普通会话继续使用 DSH 原有模型设置。Loader 必须已提供 `llm`、`credentials`、`commands` 和 `agentPresets`。本插件只拥有显式声明的提供方路由；其他适配器实例不能重复注册相同路由。

### Minimal configuration

在显式配置覆盖层中插入以下条目。源码仓库中，如果配置解析器未包含此包，请将 `name` 改为本包构建后 `lib/index.js` 的绝对路径。运行现有 CLI：`dsh --profile sdk --patch /absolute/path/fusion.patch.yml`，然后通过该配置的人类命令接口调用 `/fusion_preflight top`。此操作不会设置持久默认值。SDK 覆盖层显式允许此命令定义；原始 SDK 文本路由只允许内置命令。若已有预设注册表及适用预设，请省略相应条目。空的检查预设不组合任务工具。凭证条目仅在此显式覆盖层中启用现有本地提供方；空路由不会读取凭证。无密钥快照使用模拟凭证提供方。

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

这个最小配置会报告提供方配置被阻止，不访问网络或解析凭证。`agentPreset` 必须指向已有 DSH 预设。内置选择名为 `top`、`top-opus`、`middle`、`middle-fable-terra`、`low` 和 `low-opus-luna`，使用固定配对和升级链。检查选择不会接纳任务。

| 文档字段 | 要求 |
|---|---|
| `credentialRef` | 用于物化内置目录的主机凭证引用，不是凭证值 |
| `agentPreset` | 内置选择使用的现有能力组合 |
| `providers` | 按提供方 id 索引的显式 pi-ai 配置；空配置会被阻止 |
| `declarations` | 精确提供方和 wire-id 的 `tools`、`structuredDecisions`、`efforts` 声明；缺失则阻止 |
| `bindings` | 新目录版本中的精确模型声明；保留版本不可覆盖 |
| `selections` | 唯一名称、选择版本、预设、拓扑和辅助角色映射 |
| `metadataLimits` | 正数的单响应字节、总字节、页数和毫秒限制 |

提供方配置需要 `api`（`openai-responses` 或 `anthropic-messages`）、`baseURL`、`apiKeyEnv`、`transport: sse` 和显式 `models` 列表。模型允许精确 `id`、可选 `reasoningEfforts`（low/medium/high 到同名线上参数值的映射）及可选 `compat.forceAdaptiveThinking`。内联凭证、额外请求头、自动传输和不支持的协议会被拒绝。配置解析复用 pi-ai 验证器及适配器。Anthropic 力度需要物化模型明确支持自适应思考；`cc/` 别名或力度映射本身不构成证据。仅依据适配器及路由证据配置这些字段；示例未声明任何路由受支持。

选择拓扑为 `top`（两个 `coLeads` 和一个 `executor`）、`middle` 或 `low`（`lead`、`executor` 和有序 `upgrades`），或 `single`（`participant`）。每个引用包含 `catalogRevision` 和 `presetId`；可选 `effort` 必须等于目录中的角色力度。可选 `decider` 和 `takeover` 是独立的主导力度角色；决策者可以和参与者属于同一家族。`auxiliaries` 显式映射辅助角色。加载时解析所有引用，包括升级及辅助角色。已知模型身份不能更改家族标签，别名必须精确映射到规范身份。自定义路由使用新目录版本。

### Reading results

`selection(id)` 返回深度冻结的完整角色映射，不执行 I/O。`preflight(id, signal?)` 检查预设、pi-ai 适配器、精确协议、端点及凭证引用、显式能力和力度、当前凭证解析，再检查完整元数据中的精确模型成员关系。命令使用普通 `command/run` 和 `command/done` 记录结果，不记录原始输入、凭证或提供方错误正文。修复所报告的配置或元数据问题后重新检查。报告不证明推理可用性、后端身份或运行时安全性。

`structural: ready` 只表示不进行推理的检查通过。覆盖仍为 `live-unverified`，`defaultEligible` 始终为 false，`productAdmission` 在下游安全验证完成前仍不可用。即使显式配置满足结构检查，缺失的提供方能力元数据仍会在凭据中标为 absent。可用元数据与配置冲突时阻止绑定。

## Understand the implementation

服务在发布命令及提供方前捕获所有选择。现有预设系统拥有能力组合，现有凭证服务拥有秘密解析，LLM 注册表及 pi-ai 适配器拥有模型参数验证。本包只发送经过身份验证的 GET，禁止重定向，沿同源继续链接遍历，并在完成或失败后取消响应读取器。不完整列表中的命中仍然是 unknown。脱敏记录保留主机、端点、时间、所选 id、页数、字节数及去重排序列表的 SHA-256，不保留无关模型记录。插件卸载会取消并等待检查结束，同时撤销命令和提供方注册。

## Further Exploration

- [Agent presets](../agent-preset-registry/README.zh.md) — 能力组合和保留版本。
- [pi-ai adapter](../../llm/llm-pi-ai/README.zh.md) — 协议和力度声明。
- [Credentials](../../credentials/credentials/README.zh.md) — 引用及提供方拥有的值。
- [Tests](tests/fixtures/cordis.yml) — 可复现的无密钥 Loader 组合，也用于不加载插件的隔离检查。

<a id="dev-note"></a>

## 开发备注

提供方配置归此可选消费者拥有，普通 pi-ai 发现行为保持不变。请勿在其他位置重复注册提供方 id。测试只使用哨兵凭证及本地假元数据服务器；检查不推断能力，不访问真实凭证，也不发送合成推理探针。

## Model Experience

### Preflight command

#### What the model sees

`/fusion_preflight <selection>` 的检查结果通过命令生命周期事件直接返回给用户。模型请求、工具输入和 Script 上下文都不会收到选择或凭证。

#### Token effect

检查发送零次推理请求。元数据 GET 和配置读取不消耗模型 token。

#### KV Cache effect

检查不添加模型可见输入或运行时上下文，也不初始化 Script 堆。

## Known Limitations and Deferred Work

- **任务接纳及协作** — 本服务只提供捕获的配置和不进行推理的报告。运行时安全、检查点捕获、接管授权、恢复和执行属于下游集成。
- **实时证据及资格** — 不收集或继承实时集成及基准证据。普通成功使用不能通过此服务启用默认值。
- **元数据格式** — 支持含精确字符串 id 的 `data` 列表、显式 URL 继续链接及 Anthropic `has_more`/`last_id` 游标。不支持或格式错误的分页会阻止遍历，不能据此宣告不存在。
- **配置持久性** — Loader 拥有配置文件。本包不写任务记录或历史目录数据库；调用方保留捕获结果，身份编辑需要新版本。
