import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_SENTINEL } from "@conductor/contracts";
import {
  EnvironmentClient,
  EnvironmentIdentityMismatchError,
  MultiEnvironmentRegistry
} from "@conductor/client-runtime";
import {
  WebUiStore,
  buildOfflineWebAssets,
  computeVirtualThreadWindow,
  extractComposerFileReferences,
  formatModelSelectionLabel,
  renderHighlightedHtmlOffline,
  verifyZeroExternalAssets
} from "@conductor/web";
import {
  createConductorPairingLink,
  runConductorDoctor,
  startConductorDaemon
} from "./index.js";

describe("Phase 4 — @conductor/client-runtime (Descriptor verification, Route failover, Reconnect resume, MultiEnvironmentRegistry)", () => {
  it("verifies public descriptor before sending credentials, rejects mismatched environmentId, fails over across ordered routes, and resumes stream cursor on reconnect", async () => {
    const daemonA = await startConductorDaemon({ label: "env-A" });
    const daemonB = await startConductorDaemon({ label: "env-B" });
    const tempWorkspace = mkdtempSync(join(tmpdir(), "conductor-phase4-ws-"));
    writeFileSync(join(tempWorkspace, "hello.ts"), "export const greeting = 'Cześć';\n", "utf8");

    try {
      // Register replay instance on daemonA so we can run a turn
      daemonA.registry.registerInstance({
        instanceId: "replay-default",
        driverKind: "replay",
        label: "Replay",
        enabled: true,
        defaultModel: "replay-v1",
        config: { defaultScenario: "simple" }
      });

      // 1. Identity mismatch protection: pointing client expecting daemonA at daemonB's URL must reject BEFORE sending pairing code
      const mismatchedClient = new EnvironmentClient({
        expectedEnvironmentId: daemonA.environmentId,
        routes: [
          {
            kind: "lan",
            httpBaseUrl: `http://127.0.0.1:${daemonB.port}`,
            wsBaseUrl: `ws://127.0.0.1:${daemonB.port}`
          }
        ]
      });

      await expect(
        mismatchedClient.connectWithPairingCode({
          pairingCode: daemonA.bootstrapPairingCode
        })
      ).rejects.toThrowError(EnvironmentIdentityMismatchError);

      // Because daemonA's pairing code was never sent to daemonB, it is still unconsumed and valid on daemonA!
      // 2. Ordered route failover: first route is unreachable port 59997, second route is daemonA
      const clientA = new EnvironmentClient({
        expectedEnvironmentId: daemonA.environmentId,
        routes: [
          {
            kind: "lan",
            httpBaseUrl: "http://127.0.0.1:59997",
            wsBaseUrl: "ws://127.0.0.1:59997"
          },
          {
            kind: "loopback",
            httpBaseUrl: `http://127.0.0.1:${daemonA.port}`,
            wsBaseUrl: `ws://127.0.0.1:${daemonA.port}`
          }
        ],
        routeProbeTimeoutMs: 300
      });

      const descriptor = await clientA.connectWithPairingCode({
        pairingCode: daemonA.bootstrapPairingCode
      });
      expect(descriptor.environmentId).toBe(daemonA.environmentId);
      expect(clientA.getActiveRoute()?.kind).toBe("loopback");

      // Register project and thread via EnvironmentClient
      await clientA.call("project.register", {
        commandId: "cmd_p4_proj",
        environmentId: daemonA.environmentId,
        issuedAt: "2026-11-10T13:00:00.000Z",
        type: "project.register",
        payload: {
          projectId: "proj_p4",
          name: "Phase 4 Project",
          rootPath: tempWorkspace,
          defaultBranch: "main"
        }
      });

      await clientA.call("thread.create", {
        commandId: "cmd_p4_thr",
        environmentId: daemonA.environmentId,
        issuedAt: "2026-11-10T13:00:01.000Z",
        type: "thread.create",
        payload: {
          threadId: "thr_p4",
          projectId: "proj_p4",
          title: "Phase 4 Thread",
          providerInstanceId: "replay-default",
          model: DEFAULT_MODEL_SENTINEL,
          runtimeMode: "supervised"
        }
      });

      const updates: number[] = [];
      clientA.subscribeThread("thr_p4", (state) => {
        updates.push(state.cursorSeq);
      });

      await clientA.call("turn.start", {
        commandId: "cmd_p4_turn1",
        environmentId: daemonA.environmentId,
        issuedAt: "2026-11-10T13:00:02.000Z",
        type: "turn.start",
        payload: {
          threadId: "thr_p4",
          turnId: "turn_p4_1",
          prompt: "scenario:simple",
          attachmentIds: []
        }
      });

      await daemonA.effectWorker.drain();
      const cursorBeforeReconnect = clientA.getThreadCursorSeq("thr_p4");
      expect(cursorBeforeReconnect).toBeGreaterThan(0);

      // Test filesystem.readFile and terminal.write over RPC
      const fileRes = await clientA.call<{ path: string; content: string }>("filesystem.readFile", {
        projectId: "proj_p4",
        path: "hello.ts"
      });
      expect(fileRes.content).toContain("Cześć");

      const termRes = await clientA.call<{ ok: boolean; output: string }>("terminal.write", {
        projectId: "proj_p4",
        command: "echo $CONDUCTOR_OFFLINE_MODE"
      });
      expect(termRes.ok).toBe(true);
      expect(termRes.output).toBe("1");

      // Reconnect and verify cursorSeq is preserved
      await clientA.reconnect();
      expect(clientA.getThreadCursorSeq("thr_p4")).toBe(cursorBeforeReconnect);

      // 3. MultiEnvironmentRegistry across daemonA and daemonB
      const multiRegistry = new MultiEnvironmentRegistry();
      const regClientB = multiRegistry.registerEnvironment({
        environmentId: daemonB.environmentId,
        label: "Secondary LAN Build Box",
        routes: [
          {
            kind: "loopback",
            httpBaseUrl: `http://127.0.0.1:${daemonB.port}`,
            wsBaseUrl: `ws://127.0.0.1:${daemonB.port}`
          }
        ]
      });
      const pairB = createConductorPairingLink({
        daemon: daemonB,
        label: "peer-b"
      });
      await regClientB.connectWithPairingCode({ pairingCode: pairB.pairingCode });
      const allScopedThreads = await multiRegistry.listThreadsAcrossEnvironments();
      expect(Array.isArray(allScopedThreads)).toBe(true);

      await multiRegistry.closeAll();
      await clientA.close();
    } finally {
      await daemonA.close();
      await daemonB.close();
      rmSync(tempWorkspace, { recursive: true, force: true });
    }
  });
});

describe("Phase 4 — @conductor/web (100% Offline Bundle, Strict CSP, Thread Virtualization, Syntax Highlighting, and Composer)", () => {
  it("serves Web UI assets with Strict CSP and zero external network dependencies", async () => {
    const daemon = await startConductorDaemon();

    try {
      const htmlRes = await fetch(daemon.webUiUrl);
      expect(htmlRes.status).toBe(200);
      const cspHeader = htmlRes.headers.get("content-security-policy") ?? "";
      expect(cspHeader).toContain("default-src 'self'");
      expect(cspHeader).toContain("frame-ancestors 'none'");
      const htmlText = await htmlRes.text();
      expect(htmlText).toContain("data-conductor-offline=\"true\"");

      const cssRes = await fetch(`${daemon.webUiUrl}assets/app.css`);
      expect(cssRes.status).toBe(200);
      const jsRes = await fetch(`${daemon.webUiUrl}assets/app.js`);
      expect(jsRes.status).toBe(200);

      const assets = buildOfflineWebAssets();
      const rawMap: Record<string, string> = {};
      for (const [k, v] of Object.entries(assets)) {
        rawMap[k] = v.body;
      }
      const audit = verifyZeroExternalAssets(rawMap);
      expect(audit.valid).toBe(true);
      expect(audit.violations).toHaveLength(0);
    } finally {
      await daemon.close();
    }
  });

  it("virtualizes large 5,000-event threads, extracts @file references, and highlights code/diffs offline", () => {
    const items = Array.from({ length: 5000 }, (_, idx) => ({ id: `item_${idx}` }));
    const windowSlice = computeVirtualThreadWindow(items, {
      scrollTop: 2400,
      viewportHeight: 600,
      estimatedRowHeight: 60,
      overscan: 3
    });

    expect(windowSlice.totalCount).toBe(5000);
    expect(windowSlice.visibleItems.length).toBeLessThanOrEqual(20);
    expect(windowSlice.topSpacerHeight).toBeGreaterThan(0);
    expect(windowSlice.bottomSpacerHeight).toBeGreaterThan(0);

    const refs = extractComposerFileReferences(
      "Zrefaktoryzuj @src/orchestrator.ts oraz @packages/contracts/src/rpc.ts"
    );
    expect(refs.map((r) => r.relativePath)).toEqual([
      "src/orchestrator.ts",
      "packages/contracts/src/rpc.ts"
    ]);

    expect(formatModelSelectionLabel(DEFAULT_MODEL_SENTINEL, "qwen3-coder-30b")).toBe(
      "Domyślny (qwen3-coder-30b)"
    );

    const store = new WebUiStore();
    store.setProviderPresentation({
      driverKind: "local-llm",
      label: "Local vLLM",
      supportedRuntimeModes: ["plan-only", "supervised"],
      showInteractionModeToggle: true,
      capabilities: {
        fork: true,
        rollback: true,
        steering: true,
        subagents: false,
        nativeCheckpoints: false,
        streamingToolCalls: true
      }
    });
    store.setSelectedRuntimeMode("autonomous-sandbox");
    expect(store.getSelectedRuntimeMode()).toBe("supervised");

    const tsHtml = renderHighlightedHtmlOffline("export const x = 42; // komentarz", "typescript");
    expect(tsHtml).toContain("tok-keyword");
    expect(tsHtml).toContain("tok-number");
    expect(tsHtml).toContain("tok-comment");

    const diffHtml = renderHighlightedHtmlOffline("@@ -1,2 +1,2 @@\n-old\n+new", "diff");
    expect(diffHtml).toContain("tok-diff-hunk");
    expect(diffHtml).toContain("tok-diff-del");
    expect(diffHtml).toContain("tok-diff-add");
  });
});

describe("Phase 4 — @conductor/cli (`conductor doctor --verify-offline`)", () => {
  it("passes all offline diagnostic checks in runConductorDoctor", async () => {
    const report = await runConductorDoctor();
    expect(report.overallPassed).toBe(true);
    expect(report.checks.length).toBeGreaterThanOrEqual(5);
    for (const check of report.checks) {
      expect(check.passed).toBe(true);
    }
  });
});
