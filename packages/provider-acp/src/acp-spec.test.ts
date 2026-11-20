import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OrchestrationEventType } from "@conductor/contracts";
import type { ProviderApprovalRequest, ProviderHost } from "@conductor/provider-core";
import {
  AcpCancelNotificationSchema,
  AcpInitializeRequestSchema,
  AcpInitializeResponseSchema,
  AcpLoadSessionRequestSchema,
  AcpLoadSessionResponseSchema,
  AcpNewSessionRequestSchema,
  AcpNewSessionResponseSchema,
  AcpPromptRequestSchema,
  AcpPromptResponseSchema,
  AcpReadTextFileRequestSchema,
  AcpReadTextFileResponseSchema,
  AcpRequestPermissionRequestSchema,
  AcpRequestPermissionResponseSchema,
  AcpSessionNotificationSchema,
  AcpWriteTextFileRequestSchema,
  AcpWriteTextFileResponseSchema,
  AcpProviderAdapter,
  createMockAcpInstanceSettings
} from "./index.js";

function createTestHost(options: {
  readonly onApproval?: (req: ProviderApprovalRequest) => Promise<string>;
  readonly onPersistSessionId?: (threadId: string, sessionId: string) => void;
} = {}): {
  readonly host: ProviderHost;
  readonly events: Array<{
    readonly type: OrchestrationEventType;
    readonly payload: Record<string, unknown>;
    readonly timestamp: number;
  }>;
  readonly auditEvents: Array<{
    readonly category: string;
    readonly summary: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }>;
  readonly approvalRequests: ProviderApprovalRequest[];
} {
  const events: Array<{
    readonly type: OrchestrationEventType;
    readonly payload: Record<string, unknown>;
    readonly timestamp: number;
  }> = [];
  const auditEvents: Array<{
    readonly category: string;
    readonly summary: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }> = [];
  const approvalRequests: ProviderApprovalRequest[] = [];

  const host: ProviderHost = {
    emitStreamEvent: (ev) => {
      events.push({
        type: ev.type,
        payload: ev.payload,
        timestamp: Date.now()
      });
    },
    requestApproval: async (req, signal) => {
      approvalRequests.push(req);
      if (signal?.aborted) {
        throw new Error("Aborted");
      }
      if (options.onApproval) {
        return await new Promise((resolve, reject) => {
          const onAbort = () => reject(new Error("Aborted"));
          signal?.addEventListener("abort", onAbort, { once: true });
          options
            .onApproval!(req)
            .then((selectedOptionId) => {
              signal?.removeEventListener("abort", onAbort);
              resolve({ selectedOptionId });
            })
            .catch(reject);
        });
      }
      return { selectedOptionId: req.options[0]?.id ?? "allow-once" };
    },
    verifyOutboundUrl: async () => {},
    getThreadMcpEndpoint: (threadId, modeLimit) => ({
      url: `http://127.0.0.1:4310/mcp?threadId=${encodeURIComponent(threadId)}`,
      headers: {
        "T3-Mode-Limit": modeLimit
      }
    }),
    persistThreadSessionId: (threadId, sessionId) => {
      options.onPersistSessionId?.(threadId, sessionId);
    },
    recordAuditEvent: (category, summary, metadata) => {
      auditEvents.push({ category, summary, metadata });
    }
  };

  return { host, events, auditEvents, approvalRequests };
}

describe("ACP v1 Specification Compliance (@conductor/provider-acp)", () => {
  it("validates every outbound and inbound JSON-RPC 2.0 frame against the vendored ACP v1 schema and uses incrementing integer request IDs", async () => {
    const outboundFrames: Array<Record<string, unknown>> = [];
    const inboundFrames: Array<Record<string, unknown>> = [];
    const settings = createMockAcpInstanceSettings("acp-contract-1");
    const adapter = new AcpProviderAdapter(settings, {
      onOutboundFrame: (frame) => outboundFrames.push(frame),
      onInboundFrame: (frame) => inboundFrames.push(frame)
    });

    const ws = mkdtempSync(join(tmpdir(), "conductor-acp-ws-"));
    writeFileSync(join(ws, "hello.txt"), "Hello from workspace\n", "utf8");

    try {
      const { host, events } = createTestHost();
      const outcome = await adapter.runTurn(
        {
          threadId: "thr_contract",
          turnId: "turn_1",
          projectId: "proj_1",
          workspaceRoot: ws,
          prompt: "Sprawdź @hello.txt w projekcie",
          model: "acp-local-model",
          runtimeMode: "supervised"
        },
        host,
        new AbortController().signal
      );

      expect(outcome.status).toBe("completed");
      expect(outcome.assistantText).toContain("ACP offline response (CLEAN, OFFLINE=1)");

      // Check incrementing integer IDs on client -> agent requests
      const clientRequests = outboundFrames.filter((f) => typeof f.method === "string" && "id" in f);
      expect(clientRequests.map((r) => r.id)).toEqual([1, 2, 3]);
      expect(clientRequests.map((r) => r.method)).toEqual([
        "initialize",
        "session/new",
        "session/prompt"
      ]);

      // Validate each client request against ACP v1 Zod schemas
      const initReq = clientRequests[0]!;
      expect(AcpInitializeRequestSchema.safeParse(initReq.params).success).toBe(true);

      const newSessReq = clientRequests[1]!;
      expect(AcpNewSessionRequestSchema.safeParse(newSessReq.params).success).toBe(true);
      const newSessParams = AcpNewSessionRequestSchema.parse(newSessReq.params);
      expect(newSessParams.cwd).toBe(ws);
      expect(newSessParams.mcpServers).toHaveLength(1);
      expect(newSessParams.mcpServers[0]).toMatchObject({
        type: "http",
        name: "conductor",
        url: "http://127.0.0.1:4310/mcp?threadId=thr_contract"
      });

      const promptReq = clientRequests[2]!;
      expect(AcpPromptRequestSchema.safeParse(promptReq.params).success).toBe(true);
      const promptParams = AcpPromptRequestSchema.parse(promptReq.params);
      // Should contain resource_link for @hello.txt and text block for the prompt
      expect(promptParams.prompt.some((b) => b.type === "resource_link" && b.name === "hello.txt")).toBe(true);
      expect(promptParams.prompt.some((b) => b.type === "text")).toBe(true);

      // Validate agent responses and notifications against ACP v1 Zod schemas
      const initRes = inboundFrames.find((f) => f.id === 1)!;
      expect(AcpInitializeResponseSchema.safeParse(initRes.result).success).toBe(true);

      const newSessRes = inboundFrames.find((f) => f.id === 2)!;
      expect(AcpNewSessionResponseSchema.safeParse(newSessRes.result).success).toBe(true);

      const promptRes = inboundFrames.find((f) => f.id === 3)!;
      expect(AcpPromptResponseSchema.safeParse(promptRes.result).success).toBe(true);

      const sessionNotifs = inboundFrames.filter((f) => f.method === "session/update");
      expect(sessionNotifs.length).toBeGreaterThanOrEqual(4);
      for (const notif of sessionNotifs) {
        expect(AcpSessionNotificationSchema.safeParse(notif.params).success).toBe(true);
      }

      // Verify session/update mapping to Conductor stream events:
      // reasoning.delta, plan.updated, tool.call.started, tool.call.completed (separated in time!), message.delta
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain("reasoning.delta");
      expect(eventTypes).toContain("plan.updated");
      expect(eventTypes).toContain("tool.call.started");
      expect(eventTypes).toContain("tool.call.completed");
      expect(eventTypes).toContain("message.delta");

      const startedEv = events.find((e) => e.type === "tool.call.started")!;
      const completedEv = events.find((e) => e.type === "tool.call.completed")!;
      expect(completedEv.timestamp).toBeGreaterThanOrEqual(startedEv.timestamp);
      expect(events.indexOf(startedEv)).toBeLessThan(events.indexOf(completedEv));
    } finally {
      await adapter.closeAll();
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("reuses the same long-lived child process (same PID) and same ACP sessionId across multiple turns in a thread", async () => {
    const outboundFrames: Array<Record<string, unknown>> = [];
    const settings = createMockAcpInstanceSettings("acp-multiturn");
    const adapter = new AcpProviderAdapter(settings, {
      onOutboundFrame: (frame) => outboundFrames.push(frame)
    });

    const ws = mkdtempSync(join(tmpdir(), "conductor-acp-multiturn-"));
    try {
      const { host } = createTestHost();

      const out1 = await adapter.runTurn(
        {
          threadId: "thr_multi",
          turnId: "turn_1",
          projectId: "proj_1",
          workspaceRoot: ws,
          prompt: "Pierwsza tura",
          model: "acp-local-model",
          runtimeMode: "supervised"
        },
        host,
        new AbortController().signal
      );

      const runtimeAfterTurn1 = adapter.getSessionRuntime("thr_multi")!;
      const pid1 = runtimeAfterTurn1.getPid();
      const session1 = runtimeAfterTurn1.getSessionId();
      expect(pid1).toBeDefined();
      expect(session1).toBeDefined();

      const out2 = await adapter.runTurn(
        {
          threadId: "thr_multi",
          turnId: "turn_2",
          projectId: "proj_1",
          workspaceRoot: ws,
          prompt: "Druga tura w tej samej sesji",
          model: "acp-local-model",
          runtimeMode: "supervised"
        },
        host,
        new AbortController().signal
      );

      const runtimeAfterTurn2 = adapter.getSessionRuntime("thr_multi")!;
      const pid2 = runtimeAfterTurn2.getPid();
      const session2 = runtimeAfterTurn2.getSessionId();

      expect(out1.status).toBe("completed");
      expect(out2.status).toBe("completed");
      expect(pid2).toBe(pid1);
      expect(session2).toBe(session1);
      expect(out2.assistantText).toContain(`pid=${String(pid1)}`);
      expect(out2.assistantText).toContain(`session=${String(session1)}`);
      expect(out2.assistantText).toContain("turn=2");

      // `initialize` and `session/new` must have been sent ONLY once for both turns
      expect(outboundFrames.filter((f) => f.method === "initialize")).toHaveLength(1);
      expect(outboundFrames.filter((f) => f.method === "session/new")).toHaveLength(1);
      expect(outboundFrames.filter((f) => f.method === "session/prompt")).toHaveLength(2);
    } finally {
      await adapter.closeAll();
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("resumes an existing session via session/load after adapter restart when agentCapabilities.loadSession is true, and falls back to session/new + history when loadSession is false", async () => {
    const ws = mkdtempSync(join(tmpdir(), "conductor-acp-load-"));
    let persistedSessionId: string | undefined;

    try {
      // 1. Run Turn 1 and capture persistedSessionId
      const adapter1 = new AcpProviderAdapter(
        createMockAcpInstanceSettings("acp-load-1", { loadSession: true })
      );
      const { host: host1 } = createTestHost({
        onPersistSessionId: (_tId, sId) => {
          persistedSessionId = sId;
        }
      });

      await adapter1.runTurn(
        {
          threadId: "thr_resume",
          turnId: "turn_1",
          projectId: "proj_1",
          workspaceRoot: ws,
          prompt: "Start session",
          model: "acp-local-model",
          runtimeMode: "supervised"
        },
        host1,
        new AbortController().signal
      );
      expect(persistedSessionId).toBeDefined();
      await adapter1.closeAll();

      // 2. New adapter instance (simulating server restart) with loadSession: true -> calls session/load
      const outboundLoad: Array<Record<string, unknown>> = [];
      const adapter2 = new AcpProviderAdapter(
        createMockAcpInstanceSettings("acp-load-1", { loadSession: true }),
        { onOutboundFrame: (f) => outboundLoad.push(f) }
      );
      const { host: host2 } = createTestHost();

      const out2 = await adapter2.runTurn(
        {
          threadId: "thr_resume",
          turnId: "turn_2",
          projectId: "proj_1",
          workspaceRoot: ws,
          prompt: "Resume session after restart",
          model: "acp-local-model",
          runtimeMode: "supervised",
          acpSessionId: persistedSessionId
        },
        host2,
        new AbortController().signal
      );

      expect(out2.status).toBe("completed");
      expect(out2.assistantText).toContain(`session=${String(persistedSessionId)}`);
      expect(outboundLoad.filter((f) => f.method === "session/load")).toHaveLength(1);
      expect(outboundLoad.filter((f) => f.method === "session/new")).toHaveLength(0);
      const loadReq = outboundLoad.find((f) => f.method === "session/load")!;
      expect(AcpLoadSessionRequestSchema.safeParse(loadReq.params).success).toBe(true);
      await adapter2.closeAll();

      // 3. New adapter instance with loadSession: false -> falls back to session/new and injects history
      const outboundFallback: Array<Record<string, unknown>> = [];
      const adapter3 = new AcpProviderAdapter(
        createMockAcpInstanceSettings("acp-load-fallback", { loadSession: false }),
        { onOutboundFrame: (f) => outboundFallback.push(f) }
      );
      const out3 = await adapter3.runTurn(
        {
          threadId: "thr_resume",
          turnId: "turn_3",
          projectId: "proj_1",
          workspaceRoot: ws,
          prompt: "Continue without loadSession",
          model: "acp-local-model",
          runtimeMode: "supervised",
          acpSessionId: persistedSessionId,
          history: [
            { role: "user", content: "Poprzednie pytanie" },
            { role: "assistant", content: "Poprzednia odpowiedź" }
          ]
        },
        host2,
        new AbortController().signal
      );

      expect(out3.status).toBe("completed");
      expect(outboundFallback.filter((f) => f.method === "session/new")).toHaveLength(1);
      expect(out3.assistantText).toContain("[Prior Conversation Context]");
      await adapter3.closeAll();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("maps session/request_permission options and returns { outcome: { outcome: 'selected', optionId } } or { outcome: { outcome: 'cancelled' } }", async () => {
    const outboundFrames: Array<Record<string, unknown>> = [];
    const inboundFrames: Array<Record<string, unknown>> = [];
    const adapter = new AcpProviderAdapter(createMockAcpInstanceSettings("acp-perm"), {
      onOutboundFrame: (f) => outboundFrames.push(f),
      onInboundFrame: (f) => inboundFrames.push(f)
    });
    const ws = mkdtempSync(join(tmpdir(), "conductor-acp-perm-"));

    try {
      const { host, approvalRequests, auditEvents } = createTestHost({
        onApproval: async (req) => {
          expect(req.options).toEqual([
            { id: "opt_allow_once", label: "Zezwól raz", kind: "allow_once" },
            { id: "opt_reject_once", label: "Odrzuć", kind: "reject_once" }
          ]);
          return "opt_allow_once";
        }
      });

      const outcome = await adapter.runTurn(
        {
          threadId: "thr_perm",
          turnId: "turn_perm_1",
          projectId: "proj_1",
          workspaceRoot: ws,
          prompt: "scenario:permission",
          model: "acp-local-model",
          runtimeMode: "supervised"
        },
        host,
        new AbortController().signal
      );

      expect(outcome.status).toBe("completed");
      expect(approvalRequests).toHaveLength(1);
      expect(outcome.assistantText).toContain("Permission outcome: selected:opt_allow_once");
      expect(auditEvents.some((a) => a.category === "agent.approval")).toBe(true);

      // Verify the exact JSON-RPC response sent back to the agent matches AcpRequestPermissionResponseSchema
      const permReqFrame = inboundFrames.find((f) => f.method === "session/request_permission")!;
      expect(AcpRequestPermissionRequestSchema.safeParse(permReqFrame.params).success).toBe(true);
      const permResFrame = outboundFrames.find((f) => f.id === permReqFrame.id)!;
      expect(AcpRequestPermissionResponseSchema.safeParse(permResFrame.result).success).toBe(true);
      expect(permResFrame.result).toEqual({
        outcome: {
          outcome: "selected",
          optionId: "opt_allow_once"
        }
      });
    } finally {
      await adapter.closeAll();
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("handles fs/read_text_file and fs/write_text_file safely inside workspaceRoot, blocks path traversal, enforces runtimeMode, and returns -32601 for unadvertised terminal/*", async () => {
    const adapter = new AcpProviderAdapter(createMockAcpInstanceSettings("acp-fs"));
    const ws = mkdtempSync(join(tmpdir(), "conductor-acp-fs-"));
    writeFileSync(join(ws, "notes.txt"), "Line1\nLine2\nLine3", "utf8");

    try {
      const { host, auditEvents } = createTestHost({
        onApproval: async () => "allow-once"
      });

      // 1. Read file inside workspaceRoot
      const readOk = await adapter.runTurn(
        {
          threadId: "thr_fs",
          turnId: "turn_read_ok",
          projectId: "proj_1",
          workspaceRoot: ws,
          prompt: "scenario:fs_read:notes.txt",
          model: "acp-local-model",
          runtimeMode: "supervised"
        },
        host,
        new AbortController().signal
      );
      expect(readOk.assistantText).toContain("READ_OK:Line1\nLine2\nLine3");

      // 2. Reject path traversal outside workspaceRoot on read
      const readTraversal = await adapter.runTurn(
        {
          threadId: "thr_fs",
          turnId: "turn_read_traversal",
          projectId: "proj_1",
          workspaceRoot: ws,
          prompt: "scenario:fs_read:../../etc/passwd",
          model: "acp-local-model",
          runtimeMode: "supervised"
        },
        host,
        new AbortController().signal
      );
      expect(readTraversal.assistantText).toContain("READ_ERR:");
      expect(readTraversal.assistantText).toContain("ERR_WORKSPACE_BOUNDARY_VIOLATION");

      // 3. Reject fs/write_text_file in plan-only mode
      const writePlanOnly = await adapter.runTurn(
        {
          threadId: "thr_fs",
          turnId: "turn_write_plan",
          projectId: "proj_1",
          workspaceRoot: ws,
          prompt: "scenario:fs_write:src/blocked.ts:const x = 1;",
          model: "acp-local-model",
          runtimeMode: "plan-only"
        },
        host,
        new AbortController().signal
      );
      expect(writePlanOnly.assistantText).toContain("WRITE_ERR:");
      expect(writePlanOnly.assistantText).toContain("ERR_MODE_VIOLATION");
      expect(existsSync(join(ws, "src/blocked.ts"))).toBe(false);

      // 4. Allow fs/write_text_file in supervised mode after approval and record audit event
      const writeSupervised = await adapter.runTurn(
        {
          threadId: "thr_fs",
          turnId: "turn_write_sup",
          projectId: "proj_1",
          workspaceRoot: ws,
          prompt: "scenario:fs_write:src/allowed.ts:export const ok = true;",
          model: "acp-local-model",
          runtimeMode: "supervised"
        },
        host,
        new AbortController().signal
      );
      expect(writeSupervised.assistantText).toContain("WRITE_OK:src/allowed.ts");
      expect(readFileSync(join(ws, "src/allowed.ts"), "utf8")).toBe("export const ok = true;");
      expect(auditEvents.some((a) => a.category === "agent.file_edit" && !a.metadata?.blocked)).toBe(true);

      // 5. Reject path traversal on write
      const writeTraversal = await adapter.runTurn(
        {
          threadId: "thr_fs",
          turnId: "turn_write_trav",
          projectId: "proj_1",
          workspaceRoot: ws,
          prompt: "scenario:fs_write:../outside.txt:hacked",
          model: "acp-local-model",
          runtimeMode: "supervised"
        },
        host,
        new AbortController().signal
      );
      expect(writeTraversal.assistantText).toContain("WRITE_ERR:");
      expect(writeTraversal.assistantText).toContain("ERR_WORKSPACE_BOUNDARY_VIOLATION");

      // 6. Unadvertised terminal/create returns JSON-RPC -32601 Method not found
      const termUnsupported = await adapter.runTurn(
        {
          threadId: "thr_fs",
          turnId: "turn_term",
          projectId: "proj_1",
          workspaceRoot: ws,
          prompt: "scenario:terminal_unsupported",
          model: "acp-local-model",
          runtimeMode: "supervised"
        },
        host,
        new AbortController().signal
      );
      expect(termUnsupported.assistantText).toContain("TERMINAL_ERR_CODE:-32601");
    } finally {
      await adapter.closeAll();
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("cancels a turn gracefully via session/cancel notification (keeping the process alive) and force-kills an unresponsive process after cancelGraceMs", async () => {
    const outboundFrames: Array<Record<string, unknown>> = [];
    const adapter = new AcpProviderAdapter(
      createMockAcpInstanceSettings("acp-cancel", { cancelGraceMs: 150 }),
      { onOutboundFrame: (f) => outboundFrames.push(f) }
    );
    const ws = mkdtempSync(join(tmpdir(), "conductor-acp-cancel-"));

    try {
      // 1. Graceful cancellation while awaiting permission
      const { host: hostGraceful } = createTestHost({
        onApproval: () =>
          new Promise((resolve) => {
            setTimeout(() => resolve("allow_once_id"), 5000);
          })
      });

      const turnPromise = adapter.runTurn(
        {
          threadId: "thr_cancel_ok",
          turnId: "turn_cancel_1",
          projectId: "proj_1",
          workspaceRoot: ws,
          prompt: "scenario:cancel_graceful",
          model: "acp-local-model",
          runtimeMode: "supervised"
        },
        hostGraceful,
        new AbortController().signal
      );

      await new Promise((r) => setTimeout(r, 80));
      await adapter.cancelTurn("thr_cancel_ok", "turn_cancel_1");

      const gracefulOutcome = await turnPromise;
      expect(gracefulOutcome.status).toBe("cancelled");

      // Verify `session/cancel` notification was sent and `{ outcome: { outcome: "cancelled" } }` was returned for permission
      const cancelNotif = outboundFrames.find((f) => f.method === "session/cancel")!;
      expect(cancelNotif).toBeDefined();
      expect(AcpCancelNotificationSchema.safeParse(cancelNotif.params).success).toBe(true);

      // Process is still alive after graceful cancel!
      expect(adapter.getSessionRuntime("thr_cancel_ok")?.isAlive()).toBe(true);

      // 2. Unresponsive agent that ignores session/cancel -> killed after cancelGraceMs (150ms)
      const { host: hostHang } = createTestHost();
      const hangPromise = adapter.runTurn(
        {
          threadId: "thr_cancel_hang",
          turnId: "turn_hang_1",
          projectId: "proj_1",
          workspaceRoot: ws,
          prompt: "scenario:cancel_hang",
          model: "acp-local-model",
          runtimeMode: "supervised"
        },
        hostHang,
        new AbortController().signal
      );

      await new Promise((r) => setTimeout(r, 80));
      await adapter.cancelTurn("thr_cancel_hang", "turn_hang_1");

      const hangOutcome = await hangPromise;
      expect(hangOutcome.status).toBe("cancelled");
      expect(adapter.getSessionRuntime("thr_cancel_hang")?.isAlive()).toBe(false);
    } finally {
      await adapter.closeAll();
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("handles authenticate handshake, returns ERR_ACP_AUTH_REQUIRED when auth is missing, and maps stopReason=refusal to failed", async () => {
    const ws = mkdtempSync(join(tmpdir(), "conductor-acp-auth-"));
    const adapterMissingAuth = new AcpProviderAdapter(
      createMockAcpInstanceSettings("acp-auth-missing", { requireAuth: true })
    );
    const adapterWithAuth = new AcpProviderAdapter(
      createMockAcpInstanceSettings("acp-auth-ok", {
        requireAuth: true,
        authMethodId: "corp-token"
      })
    );

    try {
      const { host } = createTestHost();

      const missingRes = await adapterMissingAuth.runTurn(
        {
          threadId: "thr_auth_miss",
          turnId: "turn_1",
          projectId: "proj_1",
          workspaceRoot: ws,
          prompt: "Hello",
          model: "acp-local-model",
          runtimeMode: "supervised"
        },
        host,
        new AbortController().signal
      );
      expect(missingRes.status).toBe("failed");
      expect(missingRes.errorMessage).toContain("ERR_ACP_AUTH_REQUIRED");

      const okRes = await adapterWithAuth.runTurn(
        {
          threadId: "thr_auth_ok",
          turnId: "turn_1",
          projectId: "proj_1",
          workspaceRoot: ws,
          prompt: "Hello with corp token",
          model: "acp-local-model",
          runtimeMode: "supervised"
        },
        host,
        new AbortController().signal
      );
      expect(okRes.status).toBe("completed");

      const refusalRes = await adapterWithAuth.runTurn(
        {
          threadId: "thr_auth_ok",
          turnId: "turn_2",
          projectId: "proj_1",
          workspaceRoot: ws,
          prompt: "scenario:refusal",
          model: "acp-local-model",
          runtimeMode: "supervised"
        },
        host,
        new AbortController().signal
      );
      expect(refusalRes.status).toBe("failed");
      expect(refusalRes.errorMessage).toContain("refusal");
    } finally {
      await adapterMissingAuth.closeAll();
      await adapterWithAuth.closeAll();
      rmSync(ws, { recursive: true, force: true });
    }
  });

  const realBin = process.env.CONDUCTOR_TEST_REAL_ACP_BIN;
  it.skipIf(!realBin)("integrates with a real local ACP binary when CONDUCTOR_TEST_REAL_ACP_BIN is set", async () => {
    const adapter = new AcpProviderAdapter({
      instanceId: "real-acp-bin",
      driverKind: "acp",
      label: "Real ACP Binary",
      enabled: true,
      defaultModel: "default",
      config: {
        command: realBin!,
        args: (process.env.CONDUCTOR_TEST_REAL_ACP_ARGS ?? "acp").split(" ").filter(Boolean),
        env: {},
        initializeTimeoutMs: 15000,
        cancelGraceMs: 3000
      }
    });

    try {
      const { host } = createTestHost();
      const outcome = await adapter.runTurn(
        {
          threadId: "thr_real_acp",
          turnId: "turn_real_1",
          projectId: "proj_real",
          workspaceRoot: process.cwd(),
          prompt: "Say hello",
          model: "default",
          runtimeMode: "supervised"
        },
        host,
        new AbortController().signal
      );
      expect(["completed", "cancelled", "failed"]).toContain(outcome.status);
    } finally {
      await adapter.closeAll();
    }
  });
});
