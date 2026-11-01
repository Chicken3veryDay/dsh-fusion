---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-01-fusion-dormant-delivery

[English](2026-11-01-fusion-dormant-delivery.md) | 中文

## 概述

新增必读的休眠 Fusion 文本意图、接收方接受和根完成记录，以及生产方拥有的 fusion-delivery 消息来源。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-01-fusion-dormant-delivery
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "04caa8d156b07f2caf279d628cbd515bc12307c6d18c98f8c66de570ff2f52f6"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "86e911aed02f5c68c50e1817429536baaedd5edd5b6b4e19c672520a81ec0ae2"
    decision: same-version
  - root: "event:fusion/delivery-accepted"
    previous: null
    after: "bbd563a3655e8e79bc77372a6f2eac22095302a473d177a2431b06c13c5b081b"
    decision: same-version
  - root: "event:fusion/delivery-completed"
    previous: null
    after: "c926ddc12af7db3797976a67b17898f81ff3cba9d0065ecdeed44382e5468fa0"
    decision: same-version
  - root: "event:fusion/delivery-intent"
    previous: null
    after: "4c756b062d5d4774a4fb068f82a7e1a771d2ade634e092aaed7ae2990df6afaf"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "a7814aa784d48282459551c9fba2248d829015ab3385e5237cf725c938c6f5b7"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "aa3073cbecdadda8b117494dd9e87c312b664056530a76ed087158a27efe3bf9"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

现有标准记录仍然有效。旧读取器在回放或修复前拒绝每个新增必读事件的判别值。完整原始指令保留交付来源元数据。现有判别值和 Session 头版本不变。传输完成不授予执行或外部效果结算权限。

<a id="verification"></a>
## 验证

参与方、保留生命周期和写入器持久性专项测试通过；所有参与方源文件均达到每文件 100% 覆盖率。保留的上游解析器和存储校验器分别拒绝每个新增事件。TypeScript SDK 交付及未修改的 fusion-retained 回放通过。使用 `--fusion` 构建的可选 Python 可执行文件在同一核心模块闭包中通过交付和保留两项冒烟测试；默认运行时仍与实验包隔离。本记录不认证独立验收。

<a id="dev-note"></a>
## 开发备注

无。
