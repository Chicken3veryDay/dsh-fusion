/** Browser-safe durable Workstream records and operation inputs. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Caller-supplied stable identity for one immutable operation. */
export type WorkstreamOperationId = Branded<'WorkstreamOperationId'>

/** A continuable child retains the technical owner as its original parent. */
export interface WorkstreamMember {
  readonly id: SessionId
  readonly name: string
  readonly role: 'owner' | 'member'
  readonly diagnostic: string | null
  readonly description: string
  readonly provider: string
  readonly operationId: WorkstreamOperationId
  readonly prompt: string
  readonly phase: 'provisioning' | 'active' | 'stopping' | 'stopped'
}

/** Context supplied to a recipient; every field is logged before delivery. */
export interface WorkstreamContextPacket {
  readonly requirements: string
  readonly decisions: readonly string[]
  readonly cursor: string
  readonly changes: string
  readonly artifacts: readonly { readonly ref: string; readonly digest: string }[]
}

/** Immutable delivery intent with an explicit acceptance or recipient-processing receipt. */
export interface WorkstreamMessage {
  readonly operationId: WorkstreamOperationId
  readonly senderId: SessionId
  readonly targetId: SessionId
  readonly text: string
  readonly diagnostic: string | null
  readonly context: WorkstreamContextPacket | null
  readonly delivery: { readonly phase: 'intent' }
    | { readonly phase: 'accepted'; readonly messageId: MessageId }
    | { readonly phase: 'processed'; readonly messageId: MessageId }
}

/** Complete bounded durable value owned by one root Session. */
export interface WorkstreamSnapshot {
  readonly ownerSessionId: SessionId
  readonly coordinatorId: SessionId
  readonly operationId: WorkstreamOperationId
  readonly revision: number
  readonly title: string
  readonly members: readonly WorkstreamMember[]
  readonly messages: readonly WorkstreamMessage[]
}

/** Deployment bounds apply to complete retained snapshots and operations. */
export interface Config {
  /** Maximum members retained in one Workstream, including stopped members (default: 16). */
  readonly maxMembers?: number
  /** Maximum peer message receipts retained in one Workstream (default: 256). */
  readonly maxMessages?: number
  /** Maximum serialized byte size of one complete Workstream snapshot (default: 1 MiB). */
  readonly maxSnapshotBytes?: number
  /** Maximum serialized byte size of one peer message, including its context packet (default: 64 KiB). */
  readonly maxMessageBytes?: number
  /** Maximum `timeoutMs` accepted by one wait, in milliseconds (default: 1 hour). */
  readonly maxWaitMs?: number
}

/** Stable member-provisioning intent. */
export interface AddWorkstreamMemberRequest {
  readonly operationId: WorkstreamOperationId
  readonly name: string
  readonly description: string
  readonly provider: string
  readonly prompt: string
  readonly signal: AbortSignal
}

/** Stable peer delivery; absent context means an ordinary message. */
export interface SendWorkstreamMessageRequest {
  readonly operationId: WorkstreamOperationId
  readonly targetId: SessionId
  readonly text: string
  readonly context?: WorkstreamContextPacket
  readonly signal: AbortSignal
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Complete Workstream state after one admitted mutation. */
    'workstream/state': { readonly version: 1; readonly snapshot: WorkstreamSnapshot }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Null for Sessions without an owned Workstream. */
    workstream: WorkstreamSnapshot | null
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Durable attribution used to reconcile delivery without a second send. */
    'workstream-message': {
      readonly kind: 'workstream-message'
      readonly rootSessionId: SessionId
      readonly operationId: WorkstreamOperationId
      readonly senderSessionId: SessionId
    }
  }
}
