---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-01-fusion-dormant-delivery

English | [中文](2026-11-01-fusion-dormant-delivery.zh.md)

## Summary

Adds required dormant Fusion text intent, receiver acceptance and root completion records, and the producer-owned fusion-delivery message source.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing stock records remain valid. Older readers reject every new required event discriminator before replay or repair. Delivery source metadata is retained with the complete original instruction. No existing discriminator or Session header version changes. Transport completion confers neither execution nor effect settlement.

<a id="verification"></a>
## Verification

119 focused participant, retained-lifecycle and writer-durability tests passed with per-file 100% coverage of every participant source file. The preserved upstream parser and stored validator reject each new event independently. New TypeScript SDK delivery and unchanged fusion-retained replay both passed. Rebuilt Python executable delivery is blocked: optional Fusion packages are absent from its closure and external loading mixes scoped-context identities. This record does not certify Python delivery or independent acceptance.

<a id="dev-note"></a>
## Dev Note

None.
