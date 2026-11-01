/** Private task ordering shared by admission, reconciliation, adoption and teardown. */

/** Synchronous reservation followed by exclusive owned work through durability. */
export class TaskOrder {
  private tail: Promise<void> = Promise.resolve()
  private stopped = false
  private blocked: Error | undefined

  /**
   * Reserve immediately. A failed operation blocks later ordinary operations until explicit recovery.
   * @param work - operation retaining its slot until all durability work settles.
   * @param recovery - permit the owning reconciliation to resolve a blocked prefix; defaults to false.
   * @returns operation result; failure remains visible to dependent operations.
   */
  reserve<T>(work: () => Promise<T>, recovery = false): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('task order closed'))
    const operation = this.tail.then(async () => {
      if (this.stopped) throw new Error('task order closed')
      if (!recovery && this.blocked !== undefined) throw this.blocked
      try {
        const value = await work()
        if (recovery) this.blocked = undefined
        return value
      } catch (error: unknown) {
        this.blocked = error instanceof Error ? error : new Error('task operation failed', { cause: error })
        throw error
      }
    })
    this.tail = operation.then(() => {}, () => {})
    return operation
  }

  /** Stop queued operations and drain active work before releasing any Session writer. */
  close(): Promise<void> {
    this.stopped = true
    return this.tail
  }
}
