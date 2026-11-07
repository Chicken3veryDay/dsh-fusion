/** Live Session projection state with reconnect baselines. */

import type { Context } from '@deepseek-ai/cordis'
import { Deque } from '@deepseek-ai/dsh-deque'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type {
  Session, SessionId,
} from '@deepseek-ai/dsh-session'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  SessionControlBaseline,
  SessionControlFrame,
  SessionProjectionBaseline,
  SessionProjectionValues,
} from './types.ts'

/** Owns the Host-wide Session control stream. */
export class SessionControlController {
  private readonly streams = new Set<ControlQueue>()

  /** @param ctx - Host context carrying live Agent and projection services. */
  constructor(private readonly ctx: Context) {
    ctx.sessionProjections.onChanged((session, key, value, seq) => {
      this.broadcast({
        type: 'projection',
        sessionId: session.id,
        key,
        value: value as JsonValue,
        seq,
      })
    })
    ctx.effect(() => () => {
      for (const stream of this.streams) stream.end()
      this.streams.clear()
    }, 'session-controller.control')
  }

  /**
   * Open one generation of Host-wide live control state.
   * @param signal - Remote stream cancellation.
   * @returns one complete baseline followed by live replacement frames.
   */
  async *control(signal: AbortSignal): AsyncIterable<SessionControlFrame> {
    signal.throwIfAborted()
    const queue = new ControlQueue()
    this.streams.add(queue)
    try {
      yield { type: 'baseline', value: this.baseline() }
      yield* queue.iterate(signal)
    } finally {
      this.streams.delete(queue)
      queue.end()
    }
  }

  /**
   * Read one cut per live Session. A Session whose snapshot throws is listed in `failed` and logged;
   * its projection cells are Session-owned, so every other Session's cut stays exact.
   */
  private baseline(): SessionControlBaseline {
    const projections = Object.create(null) as Record<SessionId, SessionProjectionBaseline>
    const failed: SessionId[] = []
    for (const session of this.ctx.sessions.list()) {
      const block = this.projectionBaseline(session)
      if (block === undefined) failed.push(session.id)
      else projections[session.id] = block
    }
    return failed.length === 0 ? { projections } : { projections, failed }
  }

  private projectionBaseline(session: Session): SessionProjectionBaseline | undefined {
    let snapshot: ProjectionSnapshot
    try {
      snapshot = this.ctx.sessionProjections.snapshot(session)
    } catch (error) {
      this.ctx.logger.error(`session-controller: projections of Session "${session.id}" failed to fold and are omitted from the control baseline; other Sessions are unaffected: ${errorChain(error)}`)
      return undefined
    }
    return {
      asOfSeq: snapshot.asOfSeq,
      // Every projection definition validates its value before snapshot publication.
      values: snapshot.values as SessionProjectionValues,
    }
  }

  private broadcast(frame: SessionControlFrame): void {
    for (const stream of this.streams) stream.push(frame)
  }
}

class ControlQueue {
  private readonly buffer = new Deque<SessionControlFrame>()
  private wake: (() => void) | undefined
  private done = false

  push(frame: SessionControlFrame): void {
    if (this.done) return
    this.buffer.pushBack(frame)
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  end(): void {
    if (this.done) return
    this.done = true
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  async *iterate(signal: AbortSignal): AsyncIterable<SessionControlFrame> {
    const onAbort = (): void => { this.end() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      while (!this.done && !signal.aborted) {
        const frame = this.buffer.popFront()
        if (frame !== undefined) {
          yield frame
          continue
        }
        await new Promise<void>((resolve) => { this.wake = resolve })
      }
      while (this.buffer.size > 0 && !signal.aborted) yield this.buffer.popFront() as SessionControlFrame
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.end()
    }
  }
}
