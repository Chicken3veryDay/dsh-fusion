---
kind: upgrade-guide
description: "The ACP profile now loads workspace instructions strictly, logs a generated acp-context message after each client input, and annotates admitted ACP input."
---
# ACP profile adds recipient context and strict workspace instructions

English | [中文](guide.zh.md)

## Change

`dsh --profile acp` replaces its `agent-instructions` row with `mode: strict`. A discovered applicable instruction file that cannot be read, a file above `maxSourceBytes`, or a chain whose complete rendering exceeds `maxBytes` now fails the request with `AgentInstructionsError` before model dispatch. Before, the profile omitted or truncated such text and continued. Other profiles keep `mode: legacy`.

Each ACP-admitted client input is logged as `source: { kind: 'user', input: { kind: 'acp' } }` with its exact content, and each Session receives a generated `user/message` with `source.kind: 'acp-context'` after it. The message declares the recipient `ACP automation`, names the latest admitted input, and states the goal phase. It is a `snapshot` fact with no authority. Session logs written before this change stay valid and unannotated.

`@deepseek-ai/dsh-acp` now requires `sessionProjections` in its `inject` list and depends on `zod`. `UserMessage.source` gains the optional `input` field, and `MessageSourceMap` gains `acp-context`. Same-version Session readers keep working: [the persistence record](../../../persistence-changes/2026-11-08-acp-input-context.md) lists both reader directions.

## Migration

1. Profiles that patch `agent-instructions` over the ACP bundle must repeat `mode: strict` to keep strict loading, or set `mode: legacy` to restore truncation:

   ```yaml
   - id: agent-instructions
     config:
       maxBytes: 65536
       mode: strict
   ```

2. Raise `maxBytes` or `maxSourceBytes`, or shorten the named instruction file, when a request fails with `AGENT_INSTRUCTIONS_BUDGET_EXCEEDED` or `AGENT_INSTRUCTIONS_SOURCE_TOO_LARGE`. Fix permissions for `AGENT_INSTRUCTIONS_SOURCE_UNREADABLE`.
3. Compositions that mount `@deepseek-ai/dsh-acp` outside the shipped profile must provide `sessionProjections`.
4. Session readers that switch on `source.kind` should treat `acp-context` as an unprivileged fact and ignore an unknown `input` channel.
5. Confirm by prompting an ACP session and finding one `acp-context` message after the client input in its log.
