/** In-process held execution interfaces. Object identities never survive serialization or restart. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ExecutionAttemptId } from './execution-state.ts'

declare const credential: unique symbol
/** Exact owner-issued host issuer identity. */
export interface ExecutionIssuer { readonly [credential]: 'issuer' }
/** Exact task controller; cleanup access does not confer dispatch permission. */
export interface ExecutionController { readonly [credential]: 'controller' }
/** Exact live participant/run identity, invalidated by generation changes and revocation. */
export interface ExecutionRun { readonly [credential]: 'run' }
/** One logical request; retries retain this exact token. */
export interface HeldAttempt { readonly [credential]: 'attempt' }
/** Host policy classification; unknown operations refuse admission. */
export type EffectClass = 'read' | 'mutation' | 'infrastructure'
/** Stable public refusal categories; underlying errors retain the original cause. */
export type ExecutionBlockReason = 'identity' | 'lifecycle' | 'not-owner' | 'not-registered' | 'unclassified'
  | 'writer' | 'durability' | 'cleanup-unknown' | 'outcome-unknown'
/** Independent cleanup and original result durability determine whether settlement is known. */
export type ExecutionSettlement =
  | { readonly kind: 'settled'; readonly outcome: 'completed' | 'failed' | 'not-dispatched' }
  | { readonly kind: 'blocked'; readonly reason: ExecutionBlockReason; readonly attemptId: ExecutionAttemptId; readonly cause: unknown }
/** Prebound synchronous payload entry. All asynchronous guards finish before this leaf is returned. */
export interface SynchronousInvocation {
  /**
   * Enter the actual payload synchronously; throwing consumes dispatch and leaves its outcome unknown.
   * @returns original payload's eventual effect outcome.
   */
  invoke(): Promise<'completed' | 'failed' | 'uncertain'>
}
/** Independent cancellation and cleanup exist before preparation can allocate resources. */
export interface HeldProducer {
  /** @returns inert synchronous entry after all asynchronous preparation, without entering the payload. */
  prepare(): Promise<SynchronousInvocation>
  /**
   * Request cancellation independently of pending preparation or work; never await the owner drain.
   * @param reason - owner revocation reason.
   */
  cancel(reason: 'handoff' | 'stop' | 'cancel'): void
  /** @returns idempotent join of actual resource/descendant cleanup, including failed preparation. */
  cleanup(): Promise<void>
}
/** Trusted host bookkeeping only; no worker, I/O, preparation or payload may start in registerHeld. */
export interface ExecutionHostProvider {
  readonly name: string
  readonly revision: string
  /**
   * Resolve current host policy; undefined refuses, never grants a read exemption.
   * @param operation - host-owned operation identity.
   * @returns current effect classification.
   */
  classify(operation: string): EffectClass | undefined
  /**
   * Allocate a dormant identity and independently reachable cleanup anchor synchronously.
   * Must return its anchor even when later preparation can fail; throwing leaves cleanup unknown.
   * @param attempt - exact request token, already retained by the caller.
   * @param attemptId - owner-issued durable correlation identity, never authority.
   * @param agent - exact originating participant.
   * @param operation - staged host request identity.
   * @param signal - cancellation lifetime; cancellation also calls the returned anchor.
   * @returns inert held identity with independent cancel and cleanup.
   */
  registerHeld(attempt: HeldAttempt, attemptId: ExecutionAttemptId, agent: Agent, operation: string, signal: AbortSignal): HeldProducer
}
/** Host-only facade for one provider and task incarnation; never a tool or SDK argument. */
export interface TaskExecutionHost {
  readonly issuer: ExecutionIssuer
  readonly controller: ExecutionController
  /**
   * @param issuer - exact registered issuer.
   * @param agent - exact live retained participant Agent.
   * @param signal - originating run lifetime.
   * @returns opaque run bound to the current generation.
   */
  bindRun(issuer: ExecutionIssuer, agent: Agent, signal: AbortSignal): ExecutionRun
  /**
   * @param run - exact current run.
   * @param operation - host-owned operation identity.
   * @returns fresh logical request token, synchronously reserved before any provider callback.
   */
  reserve(run: ExecutionRun, operation: string): HeldAttempt
  /**
   * @param attempt - exact reserved request.
   * @returns memoized registration join; no preparation, payload or inference occurs.
   */
  register(attempt: HeldAttempt): Promise<void>
  /**
   * @param attempt - successfully registered request.
   * @returns memoized preparation/dispatch/cleanup/result join; uncertainty retains reservations.
   */
  release(attempt: HeldAttempt): Promise<ExecutionSettlement>
  /**
   * @param controller - exact task controller.
   * @param participant - retained mutation owner.
   * @returns durable grant after previous cleanup; bind a new run afterward.
   */
  grant(controller: ExecutionController, participant: SessionId): Promise<void>
  /**
   * @param controller - exact task controller.
   * @param reason - immediate admission cut reason.
   * @returns drain of all admitted phases and original result durability.
   */
  revoke(controller: ExecutionController, reason: 'handoff' | 'stop' | 'cancel'): Promise<void>
  /** @returns memoized terminal withdrawal, joining admitted owner work before releasing its lifetime pins. */
  dispose(): Promise<void>
}
