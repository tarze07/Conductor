import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runConductorDoctor, startConductorDaemon } from "@conductor/cli";
import { DEFAULT_MODEL_SENTINEL, type ThreadProjection } from "@conductor/contracts";
import {
  localLlmProviderDriver,
  startMockLocalLlmServer,
  type LocalLlmSettings
} from "@conductor/provider-local-llm";
import {
  AuditLogger,
  CheckpointStore,
  PullRequestSyncReactor
} from "@conductor/server";
import { makeSourceControlDefinitionRegistry } from "@conductor/source-control-core";
import { ForgejoGiteaAdapter } from "@conductor/source-control-forgejo";
import {
  ConductorProtocolSchemeHandler,
  DesktopAutoUpdater,
  DesktopIpcBridge,
  DesktopShellRuntime,
  buildOfflineBundle,
  isAllowedDesktopNavigationUrl,
  signIntranetReleaseManifest,
  verifyOfflineBundleDirectory
} from "./index.js";

function initGitRepo(repoDir: string): void {
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "AirGap Developer",
    GIT_AUTHOR_EMAIL: "dev@intranet.local",
    GIT_COMMITTER_NAME: "AirGap Developer",
    GIT_COMMITTER_EMAIL: "dev@intranet.local"
  };
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, env: gitEnv });
  writeFileSync(join(repoDir, "README.md"), "# Air-Gapped Workspace\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir, env: gitEnv });
  execFileSync("git", ["commit", "-m", "initial commit"], { cwd: repoDir, env: gitEnv });
}

describe("Phase 6 — Desktop `conductor://` Protocol Scheme & `localEnvironmentEnabled` Toggle", () => {
  it("serves 100% offline Web UI assets under conductor://app/* with strict CSP and blocks external navigation", () => {
    expect(isAllowedDesktopNavigationUrl("conductor://app/index.html")).toBe(true);
    expect(isAllowedDesktopNavigationUrl("conductor://app/assets/app.js")).toBe(true);
    expect(isAllowedDesktopNavigationUrl("https://evil.example.com/index.html")).toBe(false);
    expect(isAllowedDesktopNavigationUrl("file:///etc/passwd")).toBe(false);

    const handler = new ConductorProtocolSchemeHandler({
      defaultEnvironmentId: "env_desktop_test"
    });

    const indexRes = handler.resolve("conductor://app/index.html");
    expect(indexRes.statusCode).toBe(200);
    expect(indexRes.contentType).toContain("text/html");
    expect(indexRes.headers["Content-Security-Policy"]).toContain("default-src 'self'");
    expect(indexRes.body).toContain('data-environment-id="env_desktop_test"');
    expect(indexRes.sha256).toHaveLength(64);

    const traversalRes = handler.resolve("conductor://app/assets/../../etc/passwd");
    expect(traversalRes.statusCode).toBe(403);

    const externalRes = handler.resolve("https://google.com");
    expect(externalRes.statusCode).toBe(403);
  });

  it("toggles localEnvironmentEnabled dynamically while maintaining remote LAN environment connections", async () => {
    const remoteDaemon = await startConductorDaemon({
      label: "remote-lan-workstation"
    });

    const desktop = new DesktopShellRuntime({
      localEnvironmentEnabled: true
    });
    const ipc = new DesktopIpcBridge(desktop);

    try {
      const initialStatus = await desktop.start();
      expect(initialStatus.running).toBe(true);
      expect(initialStatus.localEnvironmentEnabled).toBe(true);
      expect(initialStatus.localEnvironmentId).toBeDefined();
      expect(initialStatus.registeredEnvironments).toHaveLength(1);

      // Connect a remote LAN environment alongside the local embedded server
      await ipc.invoke("desktop:connectRemoteEnvironment", {
        environmentId: remoteDaemon.environmentId,
        label: "Zdalny serwer LAN",
        routes: [
          {
            kind: "lan",
            httpBaseUrl: `http://${remoteDaemon.host}:${remoteDaemon.port}`,
            wsBaseUrl: `ws://${remoteDaemon.host}:${remoteDaemon.port}`
          }
        ],
        pairingCode: remoteDaemon.bootstrapPairingCode
      });

      const bothStatus = await ipc.invoke("desktop:getStatus");
      expect(bothStatus.registeredEnvironments).toHaveLength(2);

      // Disable embedded local environment -> Desktop operates purely as a remote client
      const remoteOnlyStatus = await ipc.invoke("desktop:setLocalEnvironmentEnabled", {
        enabled: false
      });
      expect(remoteOnlyStatus.localEnvironmentEnabled).toBe(false);
      expect(remoteOnlyStatus.localEnvironmentId).toBeUndefined();
      expect(remoteOnlyStatus.registeredEnvironments).toHaveLength(1);
      expect(remoteOnlyStatus.activeEnvironmentId).toBe(remoteDaemon.environmentId);

      // Re-enable embedded local environment -> local daemon boots and reconnects
      const restoredStatus = await ipc.invoke("desktop:setLocalEnvironmentEnabled", {
        enabled: true
      });
      expect(restoredStatus.localEnvironmentEnabled).toBe(true);
      expect(restoredStatus.localEnvironmentId).toBeDefined();
      expect(restoredStatus.registeredEnvironments).toHaveLength(2);
    } finally {
      await desktop.stop();
      await remoteDaemon.close();
    }
  });
});

describe("Phase 6 — Intranet DesktopAutoUpdater (Ed25519 + SHA-256 + NetworkGuard)", () => {
  it("verifies signed updates from an internal LAN artifact server and blocks public update servers", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

    const fakePackageBytes = Buffer.from("CONDUCTOR_AIRGAP_BINARY_V0.2.0_PAYLOAD", "utf8");
    const signedManifest = signIntranetReleaseManifest({
      version: "0.2.0",
      publishedAt: "2026-11-11T10:00:00.000Z",
      artifactPath: "/releases/conductor-0.2.0-linux-x64.tar.gz",
      artifactBytes: fakePackageBytes,
      releaseNotes: "Internal intranet release 0.2.0",
      privateKeyPem
    });

    const server = http.createServer((req, res) => {
      if (req.url === "/latest-intranet.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(signedManifest));
        return;
      }
      if (req.url === "/releases/conductor-0.2.0-linux-x64.tar.gz") {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(fakePackageBytes);
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolveListen) =>
      server.listen(0, "127.0.0.1", () => resolveListen())
    );
    const address = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const updater = new DesktopAutoUpdater({
        currentVersion: "0.1.0",
        updateServerBaseUrl: baseUrl,
        releasePublicKeyPem: publicKeyPem
      });

      const check = await updater.checkForUpdates();
      expect(check.mode).toBe("intranet-registry");
      expect(check.updateAvailable).toBe(true);
      expect(check.latestVersion).toBe("0.2.0");

      const downloaded = await updater.downloadAndVerifyUpdate(check.manifest!);
      expect(downloaded.version).toBe("0.2.0");
      expect(downloaded.payload.equals(fakePackageBytes)).toBe(true);

      // Tampering with the manifest version invalidates the Ed25519 signature
      await expect(
        updater.downloadAndVerifyUpdate({
          ...check.manifest!,
          version: "9.9.9"
        })
      ).rejects.toThrow(/ERR_UPDATER_SIGNATURE_INVALID/);

      // Public internet update server URL is blocked by NetworkGuard
      const publicUpdater = new DesktopAutoUpdater({
        currentVersion: "0.1.0",
        updateServerBaseUrl: "https://api.github.com/repos/tarze07/Conductor/releases",
        releasePublicKeyPem: publicKeyPem
      });
      await expect(publicUpdater.checkForUpdates()).rejects.toThrow(
        /ERR_EGRESS_BLOCKED_BY_POLICY/
      );
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });
});

describe("Phase 6 — Air-Gapped Offline Bundle Builder & docker-compose.intranet.yml Verification", () => {
  it("builds a self-contained offline bundle with valid SHA-256 digests and verifies docker-compose.intranet.yml isolation", () => {
    const tempBundleDir = mkdtempSync(join(tmpdir(), "conductor-airgap-bundle-"));
    try {
      const manifest = buildOfflineBundle({
        outputDir: tempBundleDir,
        version: "0.1.0",
        internalUpdateRegistryUrl: "http://10.10.0.50:8081/conductor"
      });

      expect(manifest.zeroExternalDependencies).toBe(true);
      expect(manifest.supportedFormats).toEqual([
        "tar.gz",
        "deb",
        "rpm",
        "AppImage",
        "msi",
        "docker"
      ]);

      const verification = verifyOfflineBundleDirectory(tempBundleDir);
      expect(verification.valid).toBe(true);
      expect(verification.checkedFilesCount).toBeGreaterThanOrEqual(10);
      expect(existsSync(join(tempBundleDir, "install-airgap.sh"))).toBe(true);
      expect(existsSync(join(tempBundleDir, "packages/deb/DEBIAN/control"))).toBe(true);
      expect(existsSync(join(tempBundleDir, "packages/rpm/conductor.spec"))).toBe(true);
      expect(existsSync(join(tempBundleDir, "packages/appimage/AppRun"))).toBe(true);
      expect(existsSync(join(tempBundleDir, "packages/msi/conductor.wxs"))).toBe(true);

      // Verify docker-compose.intranet.yml enforces internal: true and network_mode: "none"
      const composePath = resolve(process.cwd(), "docker-compose.intranet.yml");
      const composeText = readFileSync(composePath, "utf8");
      expect(composeText).toContain("internal: true");
      expect(composeText).toContain('network_mode: "none"');
      expect(composeText).toContain('CONDUCTOR_OFFLINE_MODE: "1"');
    } finally {
      rmSync(tempBundleDir, { recursive: true, force: true });
    }
  });
});

describe("Phase 6 — Full End-to-End Air-Gapped Workflow (--network=none Simulation)", () => {
  it("executes a complete Desktop -> RPC -> Orchestrator -> Local LLM -> Tool Approval -> Git Checkpoint -> Forgejo PR Sync -> AuditLog -> Rollback cycle", async () => {
    // 1. Verify `conductor doctor --verify-offline` passes 100%
    const doctorReport = await runConductorDoctor();
    expect(doctorReport.overallPassed).toBe(true);

    // 2. Initialize isolated Git workspace and capture baseline checkpoint
    const repoDir = mkdtempSync(join(tmpdir(), "conductor-e2e-repo-"));
    initGitRepo(repoDir);
    const checkpointStore = new CheckpointStore();
    const baselineCkpt = checkpointStore.captureCheckpoint({
      repoPath: repoDir,
      threadId: "thr_e2e",
      turnId: "baseline"
    });

    // 3. Start local mock vLLM server & local mock Forgejo server on 127.0.0.1
    const mockLlm = await startMockLocalLlmServer([
      {
        sseChunks: [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_e2e_write_1",
                      function: {
                        name: "write_file",
                        arguments: JSON.stringify({
                          path: "src/airgap-feature.ts",
                          content: "export const AIRGAP_READY = true;\n"
                        })
                      }
                    }
                  ]
                }
              }
            ]
          }
        ]
      },
      {
        sseChunks: [
          {
            choices: [
              {
                delta: {
                  content: "Utworzono plik src/airgap-feature.ts w środowisku Air-Gapped."
                }
              }
            ]
          }
        ]
      }
    ]);

    let forgejoPort = 0;
    let forgejoPrMerged = false;
    const mockForgejo = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && req.url?.startsWith("/forgejo/api/v1/repos/")) {
        res.end(
          JSON.stringify({
            number: 42,
            title: "feat: airgap module",
            html_url: `http://127.0.0.1:${forgejoPort}/intranet/conductor-app/pulls/42`,
            state: forgejoPrMerged ? "closed" : "open",
            merged: forgejoPrMerged,
            head: { ref: "feat/airgap" },
            base: { ref: "main" }
          })
        );
        return;
      }
      if (req.method === "GET" && req.url?.includes("/pulls/42")) {
        res.end(
          JSON.stringify({
            number: 42,
            title: "feat: airgap module",
            html_url: `http://127.0.0.1:${forgejoPort}/intranet/conductor-app/pulls/42`,
            state: forgejoPrMerged ? "closed" : "open",
            merged: forgejoPrMerged,
            head: { ref: "feat/airgap" },
            base: { ref: "main" }
          })
        );
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not_found" }));
    });
    await new Promise<void>((r) => mockForgejo.listen(0, "127.0.0.1", () => r()));
    forgejoPort = (mockForgejo.address() as { port: number }).port;

    // 4. Boot DesktopShellRuntime with embedded local server
    const desktop = new DesktopShellRuntime({
      localEnvironmentEnabled: true
    });

    try {
      const status = await desktop.start();
      const daemon = desktop.getLocalDaemon()!;
      const client = desktop.getEnvironmentClient(status.localEnvironmentId!)!;

      // Register the local vLLM instance on the daemon's ProviderRegistry
      daemon.registry.registerDriver(localLlmProviderDriver);
      const llmSettings: LocalLlmSettings = {
        instanceId: "vllm-intranet-e2e",
        driverKind: "local-llm",
        label: "Intranet vLLM (Air-Gap E2E)",
        enabled: true,
        defaultModel: "qwen3-coder-30b-intranet",
        baseUrl: mockLlm.baseUrl,
        config: {
          engineType: "vllm",
          apiFormat: "openai-compatible",
          maxSteps: 6,
          temperature: 0.1,
          stream: true
        }
      };
      daemon.registry.registerInstance(llmSettings);

      // Attach Forgejo PullRequestSyncReactor & AuditLogger
      const scmRegistry = makeSourceControlDefinitionRegistry([
        {
          id: "forgejo-e2e",
          kind: "forgejo",
          label: "Intranet Forgejo",
          baseUrl: `http://127.0.0.1:${forgejoPort}`,
          apiBaseUrl: `http://127.0.0.1:${forgejoPort}/forgejo/api/v1`
        }
      ]);
      const forgejoAdapter = new ForgejoGiteaAdapter({
        hostDefinition: scmRegistry.getById("forgejo-e2e")!,
        accessToken: "forgejo-local-token"
      });

      const prReactor = new PullRequestSyncReactor({
        environmentId: daemon.environmentId,
        sink: daemon.sink,
        orchestrator: daemon.orchestrator,
        definitionRegistry: scmRegistry
      });
      prReactor.registerAdapter(forgejoAdapter);

      const auditLogFile = join(repoDir, ".conductor-audit.jsonl");
      const auditLogger = new AuditLogger({
        jsonlFilePath: auditLogFile
      });

      // 5. Register project and create thread over WebSocket RPC (`EnvironmentClient`)
      await client.call("project.register", {
        commandId: "cmd_e2e_proj",
        environmentId: daemon.environmentId,
        issuedAt: "2026-11-11T10:20:00.000Z",
        type: "project.register",
        payload: {
          projectId: "proj_e2e",
          name: "Air-Gapped E2E Project",
          rootPath: repoDir,
          defaultBranch: "main"
        }
      });

      await client.call("thread.create", {
        commandId: "cmd_e2e_thr",
        environmentId: daemon.environmentId,
        issuedAt: "2026-11-11T10:20:01.000Z",
        type: "thread.create",
        payload: {
          threadId: "thr_e2e",
          projectId: "proj_e2e",
          title: "Implement Air-Gap Feature",
          providerInstanceId: "vllm-intranet-e2e",
          model: DEFAULT_MODEL_SENTINEL,
          runtimeMode: "supervised"
        }
      });

      auditLogger.logEvent("agent.prompt", {
        actor: "dev@intranet.local",
        environmentId: daemon.environmentId,
        threadId: "thr_e2e",
        summary: "Created thread thr_e2e in supervised mode"
      });

      // Subscribe to the thread event stream over WebSocket and auto-approve supervised tool request
      const approvedRequestIds = new Set<string>();
      client.subscribeThread("thr_e2e", (streamState) => {
        desktop.getWebUiStore().applyThreadStreamUpdate(streamState.snapshot, streamState.events);
        for (const ev of streamState.events) {
          if (ev.type === "runtime-request.opened") {
            const reqId = String(ev.payload.requestId);
            if (!approvedRequestIds.has(reqId)) {
              approvedRequestIds.add(reqId);
              void client.call("runtime-request.respond", {
                commandId: `cmd_approve_${reqId}`,
                environmentId: daemon.environmentId,
                issuedAt: new Date().toISOString(),
                type: "runtime-request.respond",
                payload: {
                  threadId: "thr_e2e",
                  requestId: reqId,
                  selectedOptionId: "allow-once"
                }
              });
            }
          }
        }
      });

      // 6. Start the agent turn over WebSocket RPC
      await client.call("turn.start", {
        commandId: "cmd_e2e_turn_1",
        environmentId: daemon.environmentId,
        issuedAt: "2026-11-11T10:20:02.000Z",
        type: "turn.start",
        payload: {
          threadId: "thr_e2e",
          turnId: "turn_e2e_1",
          prompt: "Stwórz plik src/airgap-feature.ts",
          attachmentIds: []
        }
      });

      await daemon.effectWorker.drain();

      // Create & link Pull Request on local Forgejo and sync status
      await prReactor.createAndLinkPullRequest({
        threadId: "thr_e2e",
        remoteUrl: `http://127.0.0.1:${forgejoPort}/intranet/conductor-app.git`,
        title: "feat: airgap module",
        headBranch: "feat/airgap",
        baseBranch: "main"
      });

      auditLogger.logEvent("agent.file_edit", {
        actor: "agent:vllm-intranet-e2e",
        environmentId: daemon.environmentId,
        threadId: "thr_e2e",
        turnId: "turn_e2e_1",
        summary: "Created src/airgap-feature.ts and linked Forgejo PR #42"
      });

      // 7. Verify file creation, Git checkpoint diff, Forgejo PR projection, and AuditLog integrity
      const createdFilePath = join(repoDir, "src/airgap-feature.ts");
      expect(existsSync(createdFilePath)).toBe(true);
      expect(readFileSync(createdFilePath, "utf8")).toContain("AIRGAP_READY = true");

      const turnProjection = daemon.sink.getTurn("turn_e2e_1");
      expect(turnProjection?.status).toBe("completed");
      expect(turnProjection?.checkpointRef).toBe(
        "refs/conductor/checkpoints/thr_e2e/turn_e2e_1"
      );

      const diffResult = await client.call<{ patch: string }>("checkpoint.diff", {
        repoPath: repoDir,
        fromRef: baselineCkpt.checkpointRef,
        toRef: turnProjection!.checkpointRef!
      });
      expect(diffResult.patch).toContain("AIRGAP_READY = true");

      const threadProj = await client.call<ThreadProjection>("thread.get", {
        threadId: "thr_e2e"
      });
      expect(threadProj.pullRequests).toHaveLength(1);
      expect(threadProj.pullRequests[0]?.number).toBe(42);
      expect(threadProj.pullRequests[0]?.state).toBe("open");

      expect(auditLogger.verifyIntegrity()).toBe(true);
      expect(auditLogger.getRecords()).toHaveLength(2);

      // 8. Perform 1-click atomic Checkpoint Rollback (`checkpoint.restore`) over WebSocket RPC
      await client.call("checkpoint.restore", {
        commandId: "cmd_e2e_restore_baseline",
        environmentId: daemon.environmentId,
        issuedAt: "2026-11-11T10:20:05.000Z",
        type: "checkpoint.restore",
        payload: {
          threadId: "thr_e2e",
          targetTurnId: "baseline",
          checkpointRef: baselineCkpt.checkpointRef
        }
      });

      await daemon.effectWorker.drain();

      // Verify working tree was atomically rolled back to pre-turn state
      expect(existsSync(createdFilePath)).toBe(false);
      expect(existsSync(join(repoDir, "README.md"))).toBe(true);
    } finally {
      await desktop.stop();
      await mockLlm.close();
      mockForgejo.closeAllConnections();
      await new Promise<void>((r) => mockForgejo.close(() => r()));
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
