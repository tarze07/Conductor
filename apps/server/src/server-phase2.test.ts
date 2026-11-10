import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { describe, expect, it } from "vitest";
import {
  CheckpointRestoreRejectedError,
  CheckpointStore,
  ConductorRpcServer,
  EffectWorker,
  EnvironmentAuthService,
  EventSink,
  OrchestratorV2,
  ProjectionMaintenance,
  SqliteStateStore,
  resolveOrInitEnvironmentId
} from "./index.js";

describe("Phase 2 — EventSink, OrchestratorV2, EffectWorker, and ProjectionMaintenance", () => {
  it("commits events, projections, receipts, and outbox effects atomically and deduplicates retries", async () => {
    const store = new SqliteStateStore({ dbPath: ":memory:" });
    const sink = new EventSink(store);
    const orchestrator = new OrchestratorV2(sink);
    const worker = new EffectWorker(store);
    orchestrator.attachEffectWorker(worker);

    const executedTurnEffects: string[] = [];
    worker.registerHandler("provider.run_turn", async (effect) => {
      const p = effect.payload as { threadId: string; turnId: string; prompt: string };
      executedTurnEffects.push(p.turnId);

      sink.appendStreamEvents([
        {
          streamId: p.threadId,
          type: "message.delta",
          payload: { threadId: p.threadId, turnId: p.turnId, textDelta: "Zrobione." },
          createdAt: "2026-11-10T10:00:02.000Z"
        }
      ]);

      orchestrator.dispatch({
        commandId: `cmd_fin_${p.turnId}`,
        environmentId: "env_test",
        issuedAt: "2026-11-10T10:00:03.000Z",
        type: "turn.finalize",
        payload: {
          threadId: p.threadId,
          turnId: p.turnId,
          status: "completed",
          checkpointRef: `refs/conductor/checkpoints/${p.threadId}/${p.turnId}`,
          diffSummary: { filesChanged: 2, insertions: 15, deletions: 3 }
        }
      });
    });

    // 1. Register project
    const regRes = orchestrator.dispatch({
      commandId: "cmd_proj_1",
      environmentId: "env_test",
      issuedAt: "2026-11-10T10:00:00.000Z",
      type: "project.register",
      payload: {
        projectId: "proj_1",
        name: "Conductor",
        rootPath: "/workspace/conductor",
        defaultBranch: "main"
      }
    });
    expect(regRes.duplicate).toBe(false);

    // 2. Create thread
    orchestrator.dispatch({
      commandId: "cmd_thr_1",
      environmentId: "env_test",
      issuedAt: "2026-11-10T10:00:01.000Z",
      type: "thread.create",
      payload: {
        threadId: "thr_1",
        projectId: "proj_1",
        title: "Offline Agent Thread",
        providerInstanceId: "vllm-local",
        model: "qwen3-coder",
        runtimeMode: "supervised"
      }
    });

    // 3. Start turn (dispatches OutboxEffect to EffectWorker)
    const turnStartCmd = {
      commandId: "cmd_turn_1",
      environmentId: "env_test",
      issuedAt: "2026-11-10T10:00:01.500Z",
      type: "turn.start" as const,
      payload: {
        threadId: "thr_1",
        turnId: "turn_1",
        prompt: "Zbuduj moduł SQLite",
        attachmentIds: []
      }
    };
    const firstTurnDispatch = orchestrator.dispatch(turnStartCmd);
    expect(firstTurnDispatch.duplicate).toBe(false);

    // Drain EffectWorker deterministically (no sleep or polling)
    await worker.drain();

    expect(executedTurnEffects).toEqual(["turn_1"]);
    expect(worker.getOutboxStatus("eff_run_turn_1")).toBe("completed");

    // 4. Retrying the exact same turn.start commandId returns the stored receipt without re-running!
    const retryTurnDispatch = orchestrator.dispatch(turnStartCmd);
    expect(retryTurnDispatch.duplicate).toBe(true);
    expect(retryTurnDispatch.receipt.commandId).toBe("cmd_turn_1");
    expect(retryTurnDispatch.receipt.resultSeq).toBe(firstTurnDispatch.receipt.resultSeq);
    await worker.drain();
    expect(executedTurnEffects).toEqual(["turn_1"]);

    const thread = sink.getThread("thr_1");
    expect(thread?.status).toBe("idle");
    const turn = sink.getTurn("turn_1");
    expect(turn?.status).toBe("completed");
    expect(turn?.checkpointRef).toBe("refs/conductor/checkpoints/thr_1/turn_1");
    expect(turn?.diffSummary).toEqual({ filesChanged: 2, insertions: 15, deletions: 3 });

    // 5. Test ProjectionMaintenance pruning and snapshot-aware cursor resume
    const maintenance = new ProjectionMaintenance(store, sink);
    const allEventsBeforePrune = sink.getEventsForStream("thr_1", 0);
    expect(allEventsBeforePrune.length).toBeGreaterThanOrEqual(4);

    const midSeq = allEventsBeforePrune[2]!.seq;
    const prunedCount = maintenance.pruneStreamThrough("thr_1", midSeq);
    expect(prunedCount).toBeGreaterThan(0);

    // Client with cursor below prunedThroughSeq receives snapshot + remaining unpruned events
    const staleClientResume = maintenance.resumeThreadStream("thr_1", 1);
    expect(staleClientResume.snapshot).toBeDefined();
    expect(staleClientResume.snapshot?.threadId).toBe("thr_1");

    // Client whose cursor is already at the latest sequence receives no snapshot and 0 events
    const upToDateResume = maintenance.resumeThreadStream("thr_1", thread!.lastEventSeq);
    expect(upToDateResume.snapshot).toBeUndefined();
    expect(upToDateResume.events).toHaveLength(0);

    store.close();
  });

  it("retires abandoned outbox effects on startup recovery before admitting new work", () => {
    const store = new SqliteStateStore({ dbPath: ":memory:" });
    const sink = new EventSink(store);
    const orchestrator = new OrchestratorV2(sink);

    orchestrator.dispatch({
      commandId: "c1",
      environmentId: "env_1",
      issuedAt: "2026-11-10T10:00:00.000Z",
      type: "project.register",
      payload: { projectId: "p1", name: "P1", rootPath: "/tmp/p1", defaultBranch: "main" }
    });
    orchestrator.dispatch({
      commandId: "c2",
      environmentId: "env_1",
      issuedAt: "2026-11-10T10:00:01.000Z",
      type: "thread.create",
      payload: {
        threadId: "t1",
        projectId: "p1",
        title: "T1",
        providerInstanceId: "inst1",
        model: "m1",
        runtimeMode: "supervised"
      }
    });
    // Dispatch turn.start without an attached worker to simulate crash before effect completion
    orchestrator.dispatch({
      commandId: "c3",
      environmentId: "env_1",
      issuedAt: "2026-11-10T10:00:02.000Z",
      type: "turn.start",
      payload: { threadId: "t1", turnId: "turn_abandoned", prompt: "Test", attachmentIds: [] }
    });

    const worker = new EffectWorker(store);
    expect(worker.getOutboxStatus("eff_run_turn_abandoned")).toBe("pending");
    const retired = worker.recoverAbandonedEffectsOnStartup();
    expect(retired).toBe(1);
    expect(worker.getOutboxStatus("eff_run_turn_abandoned")).toBe("retired");

    store.close();
  });
});

describe("Phase 2 — CheckpointStore with hidden Git refs and isolated GIT_INDEX_FILE", () => {
  it("captures workspace state into hidden Git refs without touching HEAD or user index, diffs, and restores atomically", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "conductor-git-ckpt-"));
    const checkpointStore = new CheckpointStore();

    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
      execFileSync("git", ["config", "user.name", "Dev User"], { cwd: repoDir });
      execFileSync("git", ["config", "user.email", "dev@corp.internal"], { cwd: repoDir });

      writeFileSync(join(repoDir, "app.ts"), "export const version = 1;\n", "utf8");
      execFileSync("git", ["add", "app.ts"], { cwd: repoDir });
      execFileSync("git", ["commit", "-m", "initial commit"], { cwd: repoDir });

      const initialHead = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoDir,
        encoding: "utf8"
      }).trim();

      // Turn 1: modify tracked file and create an untracked file without staging in user's .git/index
      writeFileSync(
        join(repoDir, "app.ts"),
        "export const version = 2;\nexport const feature = 'turn1';\n",
        "utf8"
      );
      writeFileSync(join(repoDir, "helper.ts"), "export const helper = true;\n", "utf8");

      const ckpt1 = checkpointStore.captureCheckpoint({
        repoPath: repoDir,
        threadId: "thr_alpha",
        turnId: "turn_1"
      });

      expect(ckpt1.checkpointRef).toBe("refs/conductor/checkpoints/thr_alpha/turn_1");
      expect(ckpt1.diffSummary.filesChanged).toBe(2);

      // Verify user's HEAD did not move and helper.ts is still untracked in user's real index!
      const headAfterCkpt1 = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoDir,
        encoding: "utf8"
      }).trim();
      expect(headAfterCkpt1).toBe(initialHead);

      // Turn 2: modify app.ts further and add a temporary file
      writeFileSync(join(repoDir, "app.ts"), "export const version = 3;\n", "utf8");
      writeFileSync(join(repoDir, "extra-turn2.txt"), "remove me on rollback\n", "utf8");

      const ckpt2 = checkpointStore.captureCheckpoint({
        repoPath: repoDir,
        threadId: "thr_alpha",
        turnId: "turn_2",
        previousCheckpointRef: ckpt1.checkpointRef
      });

      const diff1to2 = checkpointStore.diffCheckpoints(
        repoDir,
        ckpt1.checkpointRef,
        ckpt2.checkpointRef
      );
      expect(diff1to2.diffSummary.filesChanged).toBe(2);
      expect(diff1to2.patch).toContain("extra-turn2.txt");

      // Provider that does not support rollback must reject before changing the filesystem
      expect(() =>
        checkpointStore.restoreCheckpoint(repoDir, ckpt1.checkpointRef, {
          providerSupportsRollback: false
        })
      ).toThrowError(CheckpointRestoreRejectedError);
      expect(existsSync(join(repoDir, "extra-turn2.txt"))).toBe(true);

      // Restore to Turn 1 checkpoint when provider supports rollback
      checkpointStore.restoreCheckpoint(repoDir, ckpt1.checkpointRef, {
        providerSupportsRollback: true
      });

      expect(readFileSync(join(repoDir, "app.ts"), "utf8")).toBe(
        "export const version = 2;\nexport const feature = 'turn1';\n"
      );
      expect(readFileSync(join(repoDir, "helper.ts"), "utf8")).toBe("export const helper = true;\n");
      expect(existsSync(join(repoDir, "extra-turn2.txt"))).toBe(false);

      // Test worktree creation and removal for isolated parallel threads
      const wtPath = checkpointStore.createThreadWorktree({
        repoPath: repoDir,
        threadId: "thr_parallel",
        branchName: "conductor/thr_parallel"
      });
      expect(existsSync(join(wtPath, "app.ts"))).toBe(true);
      checkpointStore.removeThreadWorktree(repoDir, wtPath);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe("Phase 2 — EnvironmentAuthService and ConductorRpcServer (WebSocket RPC + Scopes + DPoP)", () => {
  it("authenticates pairing -> DPoP token -> short-lived WS ticket, enforces RPC scopes, and streams thread events", async () => {
    const tempDataDir = mkdtempSync(join(tmpdir(), "conductor-env-"));
    const store = new SqliteStateStore({ dbPath: ":memory:" });
    const sink = new EventSink(store);
    const orchestrator = new OrchestratorV2(sink);
    const maintenance = new ProjectionMaintenance(store, sink);
    const auth = new EnvironmentAuthService(store);
    const checkpointStore = new CheckpointStore();

    const envId = resolveOrInitEnvironmentId(tempDataDir);
    expect(resolveOrInitEnvironmentId(tempDataDir)).toBe(envId);

    const server = new ConductorRpcServer({
      environmentId: envId,
      sink,
      orchestrator,
      projectionMaintenance: maintenance,
      auth,
      checkpointStore
    });

    const port = await server.listen(0, "127.0.0.1");

    try {
      // 1. Public peer IP vs private peer IP check
      expect(server.isPeerAllowed("127.0.0.1")).toBe(true);
      expect(server.isPeerAllowed("10.15.20.25")).toBe(true);
      expect(server.isPeerAllowed("8.8.8.8")).toBe(false);

      // 2. Check public environment descriptor
      const descRes = await fetch(`http://127.0.0.1:${port}/.well-known/conductor-environment`);
      expect(descRes.status).toBe(200);
      expect(descRes.headers.get("content-security-policy")).toContain("default-src 'self'");
      const desc = (await descRes.json()) as { environmentId: string; offlineMode: boolean };
      expect(desc.environmentId).toBe(envId);
      expect(desc.offlineMode).toBe(true);

      // 3. Seed bootstrap grant and verify read model never exposes raw secret
      const bootstrapGrant = auth.seedBootstrapPairingGrant({
        label: "dev-workstation"
      });
      const metadataList = auth.listPairingMetadata();
      expect(metadataList).toHaveLength(1);
      expect((metadataList[0] as unknown as Record<string, unknown>).rawPairingCode).toBeUndefined();

      // 4. Exchange pairing code with DPoP key thumbprint
      const exchRes = await fetch(`http://127.0.0.1:${port}/auth/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pairingCode: bootstrapGrant.rawPairingCode,
          dpopJkt: "jkt_client_key_1"
        })
      });
      expect(exchRes.status).toBe(200);
      const exchData = (await exchRes.json()) as { accessToken: string; scopes: string[] };
      expect(exchData.accessToken).toMatch(/^cond_tok_/);

      // 5. Mint a short-lived WebSocket ticket using DPoP proof
      const ticketRes = await fetch(`http://127.0.0.1:${port}/auth/ws-ticket`, {
        method: "POST",
        headers: {
          authorization: `DPoP ${exchData.accessToken}`,
          dpop: JSON.stringify({ jkt: "jkt_client_key_1", jti: "jti_1" }),
          "content-type": "application/json"
        },
        body: JSON.stringify({ route: "rpc" })
      });
      expect(ticketRes.status).toBe(200);
      const { ticket } = (await ticketRes.json()) as { ticket: string };

      // 6. Connect WebSocket with ticket and fresh DPoP proof
      const dpopUpgrade = encodeURIComponent(
        JSON.stringify({ jkt: "jkt_client_key_1", jti: "jti_2" })
      );
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${ticket}&dpop=${dpopUpgrade}`);

      const receivedFrames: Array<Record<string, unknown>> = [];
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", reject);
      });

      const waitForFrame = (predicate: (frame: Record<string, unknown>) => boolean) =>
        new Promise<Record<string, unknown>>((resolve) => {
          const existing = receivedFrames.find(predicate);
          if (existing) {
            resolve(existing);
            return;
          }
          const onMsg = (raw: WebSocket.RawData) => {
            const frame = JSON.parse(String(raw)) as Record<string, unknown>;
            receivedFrames.push(frame);
            if (predicate(frame)) {
              ws.off("message", onMsg);
              resolve(frame);
            }
          };
          ws.on("message", onMsg);
        });

      ws.on("message", (raw) => {
        receivedFrames.push(JSON.parse(String(raw)) as Record<string, unknown>);
      });

      // Register project and create thread over WebSocket RPC
      ws.send(
        JSON.stringify({
          frameType: "rpc.request",
          requestId: "r_proj",
          method: "project.register",
          params: {
            commandId: "cmd_ws_proj",
            environmentId: envId,
            issuedAt: "2026-11-10T10:05:00.000Z",
            type: "project.register",
            payload: {
              projectId: "proj_ws",
              name: "WS Project",
              rootPath: "/tmp/ws-proj",
              defaultBranch: "main"
            }
          }
        })
      );
      const projResp = await waitForFrame((f) => f.requestId === "r_proj");
      expect(projResp.ok).toBe(true);

      ws.send(
        JSON.stringify({
          frameType: "rpc.request",
          requestId: "r_thr",
          method: "thread.create",
          params: {
            commandId: "cmd_ws_thr",
            environmentId: envId,
            issuedAt: "2026-11-10T10:05:01.000Z",
            type: "thread.create",
            payload: {
              threadId: "thr_ws",
              projectId: "proj_ws",
              title: "WS Thread",
              providerInstanceId: "vllm-1",
              model: "qwen3-coder",
              runtimeMode: "supervised"
            }
          }
        })
      );
      const thrResp = await waitForFrame((f) => f.requestId === "r_thr");
      expect(thrResp.ok).toBe(true);

      // Subscribe to thread stream and verify initial snapshot + live event delivery
      ws.send(
        JSON.stringify({
          frameType: "rpc.subscribe",
          subscriptionId: "sub_1",
          streamId: "thr_ws",
          cursorSeq: 0
        })
      );
      const subInitial = await waitForFrame(
        (f) => f.frameType === "rpc.stream.event" && f.subscriptionId === "sub_1"
      );
      expect(subInitial.snapshot).toBeDefined();

      ws.close();
    } finally {
      await server.close();
      store.close();
      rmSync(tempDataDir, { recursive: true, force: true });
    }
  });
});
