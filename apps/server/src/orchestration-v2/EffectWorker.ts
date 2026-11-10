import type { OutboxEffect } from "@conductor/contracts";
import { DrainableWorker } from "@conductor/shared";
import type { SqliteStateStore } from "../persistence/SqliteStateStore.js";

export type OutboxEffectHandler = (effect: OutboxEffect) => Promise<void> | void;

/**
 * Modeled after t3code's EffectWorker:
 * Performs side effects after intent has been recorded in SQLite, then feeds
 * results back into orchestration. Uses DrainableWorker so tests can deterministically
 * await completion of both the queue and the active effect without sleeps or polling.
 */
export class EffectWorker {
  private readonly store: SqliteStateStore;
  private readonly handlers = new Map<OutboxEffect["type"], OutboxEffectHandler>();
  private readonly worker: DrainableWorker<OutboxEffect>;
  private readonly errors: Array<{ readonly effect: OutboxEffect; readonly error: unknown }> = [];

  constructor(store: SqliteStateStore) {
    this.store = store;
    this.worker = new DrainableWorker<OutboxEffect>(
      async (effect) => {
        await this.executeEffect(effect);
      },
      {
        concurrency: 1,
        onError: (error, effect) => {
          this.errors.push({ effect, error });
        }
      }
    );
  }

  public registerHandler(type: OutboxEffect["type"], handler: OutboxEffectHandler): void {
    this.handlers.set(type, handler);
  }

  public enqueueEffects(effects: readonly OutboxEffect[]): void {
    for (const eff of effects) {
      this.worker.enqueue(eff);
    }
  }

  /**
   * Retires abandoned provider effects left in 'pending' or 'running' state after an
   * unexpected server crash, matching t3code's recovery invariant:
   * "Effects tied to a lost provider process cannot simply replay; recovery retires them before admitting new work."
   */
  public recoverAbandonedEffectsOnStartup(): number {
    const res = this.store.db
      .prepare(
        `UPDATE outbox
         SET status = 'retired'
         WHERE status IN ('pending', 'running')`
      )
      .run();
    return Number(res.changes);
  }

  public getOutboxStatus(effectId: string): OutboxEffect["status"] | undefined {
    const row = this.store.db
      .prepare("SELECT status FROM outbox WHERE effect_id = ?")
      .get(effectId) as { status: OutboxEffect["status"] } | undefined;
    return row?.status;
  }

  public getRecordedErrors(): readonly { readonly effect: OutboxEffect; readonly error: unknown }[] {
    return [...this.errors];
  }

  public drain(): Promise<void> {
    return this.worker.drain();
  }

  public get isIdle(): boolean {
    return this.worker.isIdle;
  }

  private async executeEffect(effect: OutboxEffect): Promise<void> {
    this.store.db
      .prepare(
        `UPDATE outbox
         SET status = 'running', attempts = attempts + 1
         WHERE effect_id = ?`
      )
      .run(effect.effectId);

    const handler = this.handlers.get(effect.type);
    try {
      if (handler) {
        await handler(effect);
      }
      this.store.db
        .prepare("UPDATE outbox SET status = 'completed' WHERE effect_id = ?")
        .run(effect.effectId);
    } catch (error) {
      this.store.db
        .prepare("UPDATE outbox SET status = 'retired' WHERE effect_id = ?")
        .run(effect.effectId);
      throw error;
    }
  }
}
