---
description: "Agent-native browser and desktop interaction tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-interaction-tools

English | [中文](README.zh.md)

## Summary

This package registers stable `browser_*` and `desktop_*` tools over `ctx.interaction`. Tool schemas are admitted only when the corresponding provider is ready for the exact Agent, so a Host without a configured provider does not expose unusable tools or prompt sections.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

Mount the package after `@deepseek-ai/dsh-interaction` and a provider adapter. The Web and Desktop bundles mount it for supported Hosts.

## Understand the implementation

The tools use step-time activation conditions. Browser and desktop schemas disappear when the corresponding provider is unavailable, while provider-specific compatibility tools can remain visible.

## Further Exploration

- [Interaction service](../interaction/README.md) — provider registration and Agent ownership.
- [Browser use](../../../docs/subsystems/browser-use.md) — browser operations and Session ownership.
- [Computer use](../../../docs/subsystems/computer-use.md) — desktop operations and permissions.

## Model Experience

### Browser and desktop tools

#### What the model sees

The model sees stable `browser_*` and `desktop_*` names with operation-specific JSON inputs. It does not choose a provider or receive provider credentials.

#### Token effect

Admitted tool definitions and returned operation data add the same data-dependent request cost as other DSH tools.

#### KV Cache effect

Tool definitions remain prefix-stable while provider availability and schemas stay unchanged.

## Known Limitations and Deferred Work

- The first normalized browser adapter covers navigation, observation, tabs, and screenshots. Provider-specific action and extraction operations remain available through compatibility tools until an adapter supports them.

### Dev Note

UI cards and screenshot attachment projections remain in their owning client and attachment packages; this package only registers model-facing tools.
