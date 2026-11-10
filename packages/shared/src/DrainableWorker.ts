export interface DrainableWorkerOptions<T> {
  readonly concurrency?: number;
  readonly onError?: (error: unknown, item: T) => void;
}

/**
 * Deterministic asynchronous queue worker modeled after t3code's DrainableWorker.
 * `drain()` resolves only when BOTH the pending queue AND all currently executing
 * items (including any items enqueued recursively during execution) have completed.
 */
export class DrainableWorker<T> {
  private readonly queue: T[] = [];
  private readonly drainWaiters: Array<() => void> = [];
  private readonly concurrency: number;
  private readonly processor: (item: T) => Promise<void> | void;
  private readonly onError?: (error: unknown, item: T) => void;
  private active = 0;
  private closed = false;

  constructor(
    processor: (item: T) => Promise<void> | void,
    options: DrainableWorkerOptions<T> = {}
  ) {
    const requestedConcurrency = options.concurrency ?? 1;
    if (!Number.isInteger(requestedConcurrency) || requestedConcurrency < 1) {
      throw new RangeError("DrainableWorker concurrency must be a positive integer");
    }
    this.concurrency = requestedConcurrency;
    this.processor = processor;
    this.onError = options.onError;
  }

  public enqueue(item: T): void {
    if (this.closed) {
      throw new Error("Cannot enqueue into a closed DrainableWorker");
    }
    this.queue.push(item);
    this.pump();
  }

  public get pendingCount(): number {
    return this.queue.length;
  }

  public get activeCount(): number {
    return this.active;
  }

  public get isIdle(): boolean {
    return this.queue.length === 0 && this.active === 0;
  }

  /**
   * Resolves once both the queue is empty and all in-flight tasks have settled.
   */
  public drain(): Promise<void> {
    if (this.isIdle) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.drainWaiters.push(resolve);
    });
  }

  public async close(): Promise<void> {
    this.closed = true;
    await this.drain();
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const nextItem = this.queue.shift()!;
      this.active += 1;
      void this.runItem(nextItem);
    }
  }

  private async runItem(item: T): Promise<void> {
    try {
      await this.processor(item);
    } catch (error) {
      if (this.onError) {
        this.onError(error, item);
      }
    } finally {
      this.active -= 1;
      this.pump();
      if (this.isIdle && this.drainWaiters.length > 0) {
        const waiters = this.drainWaiters.splice(0, this.drainWaiters.length);
        for (const notify of waiters) {
          notify();
        }
      }
    }
  }
}
