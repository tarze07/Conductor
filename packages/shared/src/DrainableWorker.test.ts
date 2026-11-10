import { describe, expect, it } from "vitest";
import { DrainableWorker } from "./DrainableWorker.js";
import { TamperEvidentAuditChain } from "./audit.js";

describe("DrainableWorker", () => {
  it("waits until both the queue and currently active item finish, including nested enqueues", async () => {
    const events: string[] = [];
    let releaseFirstItem!: () => void;
    const firstItemGate = new Promise<void>((resolve) => {
      releaseFirstItem = resolve;
    });

    const worker = new DrainableWorker<string>(async (item) => {
      events.push(`start:${item}`);
      if (item === "first") {
        await firstItemGate;
        worker.enqueue("nested");
      }
      events.push(`end:${item}`);
    });

    worker.enqueue("first");
    worker.enqueue("second");

    // Queue has 1 pending item ("second") and 1 active item ("first")
    expect(worker.activeCount).toBe(1);
    expect(worker.pendingCount).toBe(1);
    expect(worker.isIdle).toBe(false);

    let drained = false;
    const drainPromise = worker.drain().then(() => {
      drained = true;
    });

    await Promise.resolve();
    expect(drained).toBe(false);

    releaseFirstItem();
    await drainPromise;

    expect(drained).toBe(true);
    expect(worker.isIdle).toBe(true);
    expect(events).toEqual([
      "start:first",
      "end:first",
      "start:second",
      "end:second",
      "start:nested",
      "end:nested"
    ]);
  });

  it("captures item errors via onError and still settles drain()", async () => {
    const capturedErrors: Array<{ error: unknown; item: number }> = [];
    const worker = new DrainableWorker<number>(
      async (item) => {
        if (item === 2) {
          throw new Error("boom");
        }
      },
      {
        onError: (error, item) => {
          capturedErrors.push({ error, item });
        }
      }
    );

    worker.enqueue(1);
    worker.enqueue(2);
    worker.enqueue(3);

    await worker.drain();
    expect(worker.isIdle).toBe(true);
    expect(capturedErrors).toHaveLength(1);
    expect(capturedErrors[0]?.item).toBe(2);
  });
});

describe("TamperEvidentAuditChain", () => {
  it("links records with SHA-256 hash chain and verifies integrity", () => {
    const chain = new TamperEvidentAuditChain<{ target: string }>();
    const r1 = chain.append("network", "allow", { target: "10.0.0.5" }, "2026-11-10T10:00:00.000Z");
    const r2 = chain.append("network", "block", { target: "8.8.8.8" }, "2026-11-10T10:00:01.000Z");

    expect(r2.prevHash).toBe(r1.hash);
    expect(chain.verifyIntegrity()).toBe(true);
  });
});
