import type { OrchestrationEvent, ThreadProjection } from "@conductor/contracts";
import type { EventSink } from "./EventSink.js";
import type { SqliteStateStore } from "./SqliteStateStore.js";

export interface StreamResumeResult {
  readonly snapshot?: ThreadProjection;
  readonly events: readonly OrchestrationEvent[];
}

/**
 * Modeled after t3code's ProjectionMaintenance:
 * - Deletes older events covered by projections while keeping each stream's newest event
 *   (high-water mark) and `thread.created` anchor events.
 * - Handles client cursor resume (`resumeThreadStream`), supplying a projection snapshot
 *   whenever a client's cursor is below both the thread's newest event and `prunedThroughSeq`.
 */
export class ProjectionMaintenance {
  private readonly store: SqliteStateStore;
  private readonly sink: EventSink;

  constructor(store: SqliteStateStore, sink: EventSink) {
    this.store = store;
    this.sink = sink;
  }

  public pruneStreamThrough(threadId: string, pruneUpToSeq: number): number {
    return this.store.inTransaction(() => {
      const thread = this.sink.getThread(threadId);
      if (!thread) {
        return 0;
      }

      const effectivePruneSeq = Math.min(pruneUpToSeq, Math.max(0, thread.lastEventSeq - 1));
      if (effectivePruneSeq <= thread.prunedThroughSeq) {
        return 0;
      }

      // Delete events at or below effectivePruneSeq EXCEPT the stream's newest event and `thread.created`
      const res = this.store.db
        .prepare(
          `DELETE FROM events
           WHERE stream_id = ?
             AND seq <= ?
             AND seq < ?
             AND type != 'thread.created'`
        )
        .run(threadId, effectivePruneSeq, thread.lastEventSeq);

      this.store.db
        .prepare(
          `UPDATE projections_threads
           SET pruned_through_seq = ?
           WHERE thread_id = ? AND pruned_through_seq < ?`
        )
        .run(effectivePruneSeq, threadId, effectivePruneSeq);

      return Number(res.changes);
    });
  }

  /**
   * Resumes a thread stream from `cursorSeq`.
   * Following t3code's architecture:
   * - A client whose cursor is below both its thread's newest event and the recorded
   *   `prunedThroughSeq` missed pruned events (or is connecting fresh with `cursorSeq === 0`),
   *   so it resumes from a snapshot.
   * - Rechecks `prunedThroughSeq` after reading the replay in case a prune pass ran concurrently.
   */
  public resumeThreadStream(threadId: string, cursorSeq: number): StreamResumeResult {
    const initialThread = this.sink.getThread(threadId);
    if (!initialThread) {
      throw new Error(`Thread '${threadId}' not found`);
    }

    const events = this.sink.getEventsForStream(threadId, cursorSeq);
    const recheckedThread = this.sink.getThread(threadId)!;

    const missedPrunedEvents =
      cursorSeq < recheckedThread.lastEventSeq &&
      (cursorSeq === 0 || cursorSeq < recheckedThread.prunedThroughSeq);

    if (missedPrunedEvents) {
      return {
        snapshot: recheckedThread,
        events
      };
    }

    return {
      events
    };
  }
}
