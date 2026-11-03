---
description: "Stable agent-native browser and desktop interaction capability."
kind: "package-reference"
---

# @deepseek-ai/dsh-interaction

English | [中文](README.zh.md)

## Summary

The interaction service is the DSH-owned capability seam for browser and desktop control. Providers register one adapter per domain; the service owns exact-Agent resources, serialization, cancellation, and cleanup. Provider transports and native permission implementations remain below this interface.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

Mount the service beside one browser or desktop adapter. The service stores no browser cookies, desktop state, credentials, or screenshots.

## Understand the implementation

Providers register an effect-owned adapter. The service opens one live resource for each exact Agent, serializes operations for that Agent, and closes the resource when the Agent or provider is disposed. A replayed Session never reopens a live resource.

## Further Exploration

- [Browser use](../../../docs/subsystems/browser-use.md) — browser adapters and normalized operations.
- [Computer use](../../../docs/subsystems/computer-use.md) — desktop adapters and host permissions.

## Model Experience

### Capability availability

#### What the model sees

The Agent receives only normalized `browser_*` and `desktop_*` tools admitted by its current provider availability. Provider names and setup diagnostics remain Host metadata.

#### Token effect

The capability adds no tool schema by itself; the companion interaction-tools package supplies definitions when a provider is ready.

#### KV Cache effect

Provider availability changes which interaction tool schemas enter a request; an unchanged provider catalog preserves the reusable request prefix.

## Known Limitations and Deferred Work

- The service does not provide a provider implementation, OS permission flow, or durable browser or desktop state. Those responsibilities remain with adapters.

### Dev Note

The stable capability is intentionally smaller than any upstream browser or desktop catalog. Provider-specific operations remain below the adapter boundary.

The model-facing tools and product UI are supplied by companion packages. This package deliberately stores no browser cookies, desktop state, credentials, or screenshots.
