---
description: "Immutable Workstream evidence versions, logged context packets, and read-only aggregation of member change requests."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-workstream-evidence

English | [中文](README.zh.md)

## Summary

Workstream Evidence stores immutable, digest-verified versions of named evidence artifacts for one Workstream. Content lives in Attachments, and the root Session event log records each version's reference, digest, size, and author. The service registers `ctx.workstreamEvidence` and the `workstreamEvidence` Session projection. It also builds logged context packets from exact versions and reports change requests that forge bindings in member Sessions already record.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount `@deepseek-ai/dsh-experimental-workstream-evidence` beside `@deepseek-ai/dsh-experimental-workstream`, `@deepseek-ai/dsh-attachment` with a provider that stores verbatim files, durable Session storage, and `@deepseek-ai/dsh-session-projection`. `@deepseek-ai/dsh-experimental-forge-session` is an optional peer. Every method takes the exact live calling `Agent` and checks Workstream membership through `ctx.workstreams.requireMembership`.

The service exposes `publish`, `get`, `list`, `read`, `readText`, `prepareContext`, and `aggregateChangeRequests`.

`publish` stores the content as an Attachment file and appends the version to the root Session. `expectedVersion` is 1 for a new artifact and the next version number for an existing one; any other value returns `WORKSTREAM_EVIDENCE_STALE_VERSION`. Content is a string or `Uint8Array`. Artifact ids are 1–200 characters without `/`, `\`, or `..`. Operation ids are 1–200 characters. A retry with the same `operationId`, artifact id, expected version, and content returns the stored version; any difference returns `WORKSTREAM_EVIDENCE_PAYLOAD_MISMATCH`. Versions are never edited or removed.

`get` returns metadata for one version, or for the latest when `version` is omitted. `list` returns every artifact with its full version history. `read` streams the Attachment and checks the byte length and `sha256:` digest against the record, returning `WORKSTREAM_EVIDENCE_CORRUPT` on a mismatch or read failure. `readText` also requires the version size to be at most `maxToolTextBytes` and the bytes to be valid UTF-8, returning `WORKSTREAM_EVIDENCE_LIMIT_EXCEEDED` or `WORKSTREAM_EVIDENCE_INVALID_INPUT` otherwise.

`prepareContext` builds a `WorkstreamContextPacket` for `ctx.workstreams.sendMessage`. Each requested artifact needs an exact `version`, and the packet carries the stored `ref` and `digest` rather than a path. Artifact ids containing `/`, `\`, `..`, or a `file:` prefix are rejected as mutable or foreign links. A serialized packet above `maxContextPacketBytes` returns `WORKSTREAM_EVIDENCE_LIMIT_EXCEEDED`. The method does not send the packet.

`aggregateChangeRequests` reads `forgeSession.changeRequests` for the root and each active member and groups bindings by URL. Each entry lists one contribution per Session with its origin and latest polling update, root first. It never writes to a forge. `complete` is `false`, with a message in `diagnostics`, when the forge service is not mounted or a Session is not loaded.

Config fields, all positive safe integers: `maxBytesPerArtifact` (10 MiB), `maxArtifacts` (256), `maxVersionsPerArtifact` (64), `maxTotalBytes` (100 MiB), `maxContextPacketBytes` (65536), and `maxToolTextBytes` (65536). Exceeding a publish bound returns `WORKSTREAM_EVIDENCE_LIMIT_EXCEEDED`.

Errors are `WorkstreamEvidenceError` values with code `WORKSTREAM_EVIDENCE_NOT_FOUND`, `WORKSTREAM_EVIDENCE_UNAUTHORIZED`, `WORKSTREAM_EVIDENCE_STALE_VERSION`, `WORKSTREAM_EVIDENCE_PAYLOAD_MISMATCH`, `WORKSTREAM_EVIDENCE_LIMIT_EXCEEDED`, `WORKSTREAM_EVIDENCE_CORRUPT`, `WORKSTREAM_EVIDENCE_INVALID_INPUT`, or `WORKSTREAM_EVIDENCE_DISPOSED`.

The `workstreamEvidence` [Session projection](../../session/session-projection/README.md) is the browser-safe read path and holds `null` for Sessions without evidence. Import `@deepseek-ai/dsh-experimental-workstream-evidence/client` for browser-safe types.

## Understand the implementation

The package has five small layers:

- [`src/types.ts`](src/types.ts) owns the version, artifact, snapshot, request, change request, and config types, plus the `plugin:workstream-evidence/state` record and `workstreamEvidence` projection declarations.
- [`src/projection.ts`](src/projection.ts) validates each `plugin:workstream-evidence/state` record against a strict schema, ignores records for another owner, and rejects revision gaps.
- [`src/index.ts`](src/index.ts) serializes publishes per root Session, enforces bounds, saves content through `ctx.attachments`, appends the whole snapshot with `version: 1` as a plugin record on the root Session, flushes it, and exposes `ctx.workstreamEvidence`.
- [`src/forge-adapter.ts`](src/forge-adapter.ts) implements `aggregateChangeRequests` over `ctx.get('forgeSession')`.
- [`src/tools.ts`](src/tools.ts) registers the opt-in `workstream_evidence_*` tools.

Immutability comes from the append-only record and digest verification on read; the Attachment store does not enforce it. Publishing saves the Attachment before appending the record, so a failure between the two can leave an unreferenced Attachment.

<a id="model-experience"></a>
## Model Experience

### Opt-in Workstream Evidence tools

#### What the model sees

`WorkstreamEvidenceTools` registers `workstream_evidence_publish`, `workstream_evidence_list`, `workstream_evidence_read`, and `workstream_evidence_aggregate_prs`. Each takes `root_session_id`. Publish takes UTF-8 `text`, `artifact_id`, `operation_id`, `expected_version`, and an optional `name`. Read takes `artifact_id` and an optional `version` and returns metadata plus text. Results are the JSON value of the service result, rendered as one text block. The tools are not in the generated tool catalog because no shipped profile registers them. There is no tool for `prepareContext`.

#### Token effect

Tool definitions add schema tokens for each registered tool while `WorkstreamEvidenceTools` is mounted. `workstream_evidence_list` returns every version record, and `workstream_evidence_read` returns up to `maxToolTextBytes` of text.

#### KV Cache effect

Registering or removing the tools changes the tool list, which can replace the cached request prefix for Sessions that expose it. Tool results are append-only growth after they are produced.

## Known Limitations and Deferred Work

- The package has no browser UI. The `workstreamEvidence` projection is the only browser-facing surface.
- Evidence enters only through `publish`. The package does not capture files from the host workspace, and the tool accepts UTF-8 text only; binary content needs the service method.
- Forge aggregation is read-only. It reports only bindings already recorded in loaded Sessions, sets `complete: false` with a diagnostic for Sessions that are not loaded, and returns an empty result when the forge service is not mounted.
- Versions are never deleted or compacted, so a Workstream reaches `maxArtifacts`, `maxVersionsPerArtifact`, or `maxTotalBytes` and then rejects further publishes.
- Evidence belongs to the root Session of one Workstream. The package does not copy evidence between Workstreams.
- A failed append after a successful Attachment save can leave an unreferenced Attachment; the package does not reclaim it.

<a id="dev-note"></a>
### Dev Note

This package is experimental and has no stability promise. Session events are the authority; projection checkpoints are only replay shortcuts.
