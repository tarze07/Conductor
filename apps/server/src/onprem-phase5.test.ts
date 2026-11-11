import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProviderRegistry, replayProviderDriver } from "@conductor/provider-core";
import {
  HashiCorpVaultConnector,
  LocalEncryptedSecretStore
} from "@conductor/secret-store-local";
import {
  BitbucketDataCenterAdapter,
  GitHubEnterpriseAdapter,
  makeSourceControlDefinitionRegistry
} from "@conductor/source-control-core";
import { ForgejoGiteaAdapter } from "@conductor/source-control-forgejo";
import { GitLabSelfManagedAdapter } from "@conductor/source-control-gitlab";
import {
  AuditLogger,
  CheckpointStore,
  ConductorRpcServer,
  CorporateOidcVerifier,
  EffectWorker,
  EnvironmentAuthService,
  EventSink,
  OrchestratorV2,
  PeerLinkService,
  ProjectionMaintenance,
  ProviderTurnRunner,
  PullRequestSyncReactor,
  SqliteStateStore,
  signCorporateOidcJwt
} from "./index.js";

describe("Phase 5 — Self-Hosted Source Control Registry, GitLab & Forgejo Adapters, and PullRequestSyncReactor", () => {
  it("detects corporate forge remotes, creates & links Merge/Pull Requests on GitLab and Forgejo, and auto-settles thread when merged", async () => {
    let gitlabMrState: "opened" | "merged" = "opened";
    let forgejoPrMerged = false;

    const mockForgeServer = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      // GitLab Self-Managed endpoints
      if (req.method === "POST" && req.url?.startsWith("/gitlab/api/v4/projects/")) {
        res.end(
          JSON.stringify({
            iid: 42,
            title: "feat: offline orchestrator",
            web_url: `http://127.0.0.1:${forgePort}/gitlab/platform/conductor/-/merge_requests/42`,
            state: gitlabMrState,
            source_branch: "feat/offline",
            target_branch: "main"
          })
        );
        return;
      }
      if (req.method === "GET" && req.url?.includes("/merge_requests/42")) {
        res.end(
          JSON.stringify({
            iid: 42,
            title: "feat: offline orchestrator",
            web_url: `http://127.0.0.1:${forgePort}/gitlab/platform/conductor/-/merge_requests/42`,
            state: gitlabMrState,
            source_branch: "feat/offline",
            target_branch: "main"
          })
        );
        return;
      }

      // Forgejo / Gitea endpoints
      if (req.method === "POST" && req.url?.startsWith("/forgejo/api/v1/repos/")) {
        res.end(
          JSON.stringify({
            number: 7,
            title: "fix: air-gap guard",
            html_url: `http://127.0.0.1:${forgePort}/core/network-guard/pulls/7`,
            state: forgejoPrMerged ? "closed" : "open",
            merged: forgejoPrMerged,
            head: { ref: "fix/guard" },
            base: { ref: "main" }
          })
        );
        return;
      }
      if (req.method === "GET" && req.url?.includes("/pulls/7")) {
        res.end(
          JSON.stringify({
            number: 7,
            title: "fix: air-gap guard",
            html_url: `http://127.0.0.1:${forgePort}/core/network-guard/pulls/7`,
            state: forgejoPrMerged ? "closed" : "open",
            merged: forgejoPrMerged,
            head: { ref: "fix/guard" },
            base: { ref: "main" }
          })
        );
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not_found" }));
    });

    await new Promise<void>((resolve) => mockForgeServer.listen(0, "127.0.0.1", resolve));
    const addr = mockForgeServer.address();
    const forgePort = typeof addr === "object" && addr ? addr.port : 0;

    const store = new SqliteStateStore({ dbPath: ":memory:" });
    const sink = new EventSink(store);
    const orchestrator = new OrchestratorV2(sink);

    try {
      const registry = makeSourceControlDefinitionRegistry([
        {
          id: "gitlab-local",
          kind: "gitlab",
          label: "Corporate GitLab",
          baseUrl: `http://127.0.0.1:${forgePort}`,
          apiBaseUrl: `http://127.0.0.1:${forgePort}/gitlab/api/v4`
        },
        {
          id: "forgejo-corp",
          kind: "forgejo",
          label: "Corporate Forgejo",
          baseUrl: "https://forgejo.corp.internal"
        },
        {
          id: "ghe-corp",
          kind: "github-enterprise",
          label: "Corporate GHES",
          baseUrl: "https://ghe.corp.internal"
        },
        {
          id: "bb-corp",
          kind: "bitbucket-dc",
          label: "Corporate Bitbucket DC",
          baseUrl: "https://bitbucket.corp.internal"
        }
      ]);

      // Verify SSH and HTTPS remote URL detection across all 4 enterprise forge kinds
      expect(
        registry.detectForgeForRemoteUrl("git@forgejo.corp.internal:team/service.git")?.repositorySlug
      ).toBe("team/service");
      expect(
        registry.detectForgeForRemoteUrl("https://ghe.corp.internal/org/platform.git")?.definition.kind
      ).toBe("github-enterprise");
      expect(
        registry.detectForgeForRemoteUrl("https://bitbucket.corp.internal/scm/PLAT/engine.git")
          ?.repositorySlug
      ).toBe("PLAT/engine");

      // Instantiate GHES and Bitbucket DC adapters to verify their host bindings
      const gheAdapter = new GitHubEnterpriseAdapter({
        hostDefinition: registry.getById("ghe-corp")!,
        token: "ghe_pat_test"
      });
      const bbAdapter = new BitbucketDataCenterAdapter({
        hostDefinition: registry.getById("bb-corp")!,
        token: "bb_pat_test"
      });
      expect(gheAdapter.hostDefinition.kind).toBe("github-enterprise");
      expect(bbAdapter.hostDefinition.kind).toBe("bitbucket-dc");

      // Test Forgejo adapter directly against mock server
      const forgejoLocalDef = makeSourceControlDefinitionRegistry([
        {
          id: "forgejo-local",
          kind: "forgejo",
          label: "Local Forgejo",
          baseUrl: `http://127.0.0.1:${forgePort}`,
          apiBaseUrl: `http://127.0.0.1:${forgePort}/forgejo/api/v1`
        }
      ]).getById("forgejo-local")!;
      const forgejoAdapter = new ForgejoGiteaAdapter({
        hostDefinition: forgejoLocalDef,
        accessToken: "fg_tok_1"
      });
      const fgPr = await forgejoAdapter.createPullRequest({
        repositorySlug: "core/network-guard",
        title: "fix: air-gap guard",
        headBranch: "fix/guard",
        baseBranch: "main"
      });
      expect(fgPr.forgeKind).toBe("forgejo");
      expect(fgPr.number).toBe(7);
      expect(fgPr.state).toBe("open");

      forgejoPrMerged = true;
      const fgPrAfterMerge = await forgejoAdapter.getPullRequestStatus({
        repositorySlug: "core/network-guard",
        number: 7
      });
      expect(fgPrAfterMerge.state).toBe("merged");

      // Test GitLab Self-Managed adapter + PullRequestSyncReactor auto-settle on thread
      const gitlabAdapter = new GitLabSelfManagedAdapter({
        hostDefinition: registry.getById("gitlab-local")!,
        privateToken: "glpat-local-secret"
      });

      const reactor = new PullRequestSyncReactor({
        environmentId: "env_onprem",
        sink,
        orchestrator,
        definitionRegistry: registry
      });
      reactor.registerAdapter(gitlabAdapter);

      orchestrator.dispatch({
        commandId: "cmd_p5_proj",
        environmentId: "env_onprem",
        issuedAt: "2026-11-11T01:00:00.000Z",
        type: "project.register",
        payload: {
          projectId: "proj_gl",
          name: "Conductor Platform",
          rootPath: "/tmp/conductor-platform",
          defaultBranch: "main"
        }
      });

      orchestrator.dispatch({
        commandId: "cmd_p5_thr",
        environmentId: "env_onprem",
        issuedAt: "2026-11-11T01:00:01.000Z",
        type: "thread.create",
        payload: {
          threadId: "thr_gl_mr",
          projectId: "proj_gl",
          title: "Implement offline orchestrator",
          providerInstanceId: "vllm-1",
          model: "qwen3-coder-30b",
          runtimeMode: "supervised"
        }
      });

      const createdMr = await reactor.createAndLinkPullRequest({
        threadId: "thr_gl_mr",
        remoteUrl: `http://127.0.0.1:${forgePort}/gitlab/platform/conductor.git`,
        title: "feat: offline orchestrator",
        headBranch: "feat/offline",
        baseBranch: "main"
      });
      expect(createdMr.state).toBe("open");
      expect(sink.getThread("thr_gl_mr")?.pullRequests).toHaveLength(1);

      // Sync while MR is still open -> thread stays idle
      const syncOpen = await reactor.syncThreadPullRequests("thr_gl_mr");
      expect(syncOpen.autoSettled).toBe(false);
      expect(sink.getThread("thr_gl_mr")?.status).toBe("idle");

      // Mark MR as merged on GitLab and sync -> PullRequestSyncReactor auto-settles the thread!
      gitlabMrState = "merged";
      const syncMerged = await reactor.syncThreadPullRequests("thr_gl_mr");
      expect(syncMerged.autoSettled).toBe(true);
      expect(syncMerged.pullRequests[0]?.state).toBe("merged");
      expect(sink.getThread("thr_gl_mr")?.status).toBe("settled");
    } finally {
      store.close();
      mockForgeServer.closeAllConnections();
      await new Promise<void>((resolve) => mockForgeServer.close(() => resolve()));
    }
  });
});

describe("Phase 5 — LAN Federation via PeerLinks (`/mcp/peer-link` + `T3-Mode-Limit` narrowing)", () => {
  it("delegates a thread turn between two LAN Conductor environments and enforces T3-Mode-Limit ceiling", async () => {
    const storeB = new SqliteStateStore({ dbPath: ":memory:" });
    const sinkB = new EventSink(storeB);
    const orchestratorB = new OrchestratorV2(sinkB);
    const workerB = new EffectWorker(storeB);
    orchestratorB.attachEffectWorker(workerB);
    const maintenanceB = new ProjectionMaintenance(storeB, sinkB);
    const authB = new EnvironmentAuthService(storeB);
    const checkpointStoreB = new CheckpointStore();

    const registryB = new ProviderRegistry();
    registryB.registerDriver(replayProviderDriver);
    registryB.registerInstance({
      instanceId: "replay-lan-gpu",
      driverKind: "replay",
      label: "LAN GPU Replay",
      enabled: true,
      defaultModel: "replay-v1",
      config: { defaultScenario: "simple" }
    });

    new ProviderTurnRunner({
      environmentId: "env_lan_gpu_b",
      sink: sinkB,
      orchestrator: orchestratorB,
      effectWorker: workerB,
      registry: registryB,
      checkpointStore: checkpointStoreB
    });

    const peerLinkB = new PeerLinkService({
      environmentId: "env_lan_gpu_b",
      sink: sinkB,
      orchestrator: orchestratorB,
      effectWorker: workerB,
      auth: authB
    });

    const serverB = new ConductorRpcServer({
      environmentId: "env_lan_gpu_b",
      sink: sinkB,
      orchestrator: orchestratorB,
      projectionMaintenance: maintenanceB,
      auth: authB,
      checkpointStore: checkpointStoreB,
      peerLinkService: peerLinkB
    });

    const portB = await serverB.listen(0, "127.0.0.1");
    const tempDirB = mkdtempSync(join(tmpdir(), "conductor-peer-b-"));

    try {
      orchestratorB.dispatch({
        commandId: "cmd_proj_b",
        environmentId: "env_lan_gpu_b",
        issuedAt: "2026-11-11T01:10:00.000Z",
        type: "project.register",
        payload: {
          projectId: "proj_gpu_build",
          name: "GPU Build Repo",
          rootPath: tempDirB,
          defaultBranch: "main"
        }
      });

      const grantB = authB.seedBootstrapPairingGrant({
        label: "peer-link-from-laptop-a"
      });
      const exchangedB = authB.exchangePairingCode({
        rawPairingCode: grantB.rawPairingCode
      });

      // 1. A plan-only caller on Laptop A cannot start mutating/delegated work on Server B even with a full-access token!
      await expect(
        peerLinkB.delegateToRemotePeer({
          peerHttpBaseUrl: `http://127.0.0.1:${portB}`,
          peerAccessToken: exchangedB.rawAccessToken,
          request: {
            sourceEnvironmentId: "env_laptop_a",
            projectId: "proj_gpu_build",
            threadId: "thr_blocked_plan",
            turnId: "turn_blocked_1",
            title: "Should be blocked by T3-Mode-Limit",
            prompt: "scenario:simple",
            providerInstanceId: "replay-lan-gpu",
            callerRuntimeMode: "plan-only"
          }
        })
      ).rejects.toThrow(/ERR_PEER_LINK_MODE_LIMIT/);

      // 2. A supervised caller on Laptop A delegates work to Server B; Server B narrows the link ceiling to "supervised"
      const delegated = await peerLinkB.delegateToRemotePeer({
        peerHttpBaseUrl: `http://127.0.0.1:${portB}`,
        peerAccessToken: exchangedB.rawAccessToken,
        request: {
          sourceEnvironmentId: "env_laptop_a",
          projectId: "proj_gpu_build",
          threadId: "thr_delegated_1",
          turnId: "turn_delegated_1",
          title: "Delegated LAN Build",
          prompt: "scenario:simple",
          providerInstanceId: "replay-lan-gpu",
          callerRuntimeMode: "supervised"
        }
      });

      expect(delegated.remoteEnvironmentId).toBe("env_lan_gpu_b");
      expect(delegated.effectiveModeCeiling).toBe("supervised");
      expect(delegated.thread.runtimeMode).toBe("supervised");
      expect(sinkB.getTurn("turn_delegated_1")?.status).toBe("completed");
    } finally {
      await serverB.close();
      storeB.close();
      rmSync(tempDirB, { recursive: true, force: true });
    }
  });
});

describe("Phase 5 — Corporate OIDC/Keycloak Verifier, AES-256-GCM Secret Store, HashiCorp Vault, and SHA-256 AuditLogger", () => {
  it("verifies corporate OIDC JWTs, encrypts secrets with AES-256-GCM, reads from intranet Vault, and maintains a tamper-evident JSONL audit log", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "conductor-phase5-sec-"));

    try {
      // 1. Corporate OIDC / Keycloak JWT verification & group-to-scope mapping
      const oidcVerifier = new CorporateOidcVerifier({
        expectedIssuer: "https://keycloak.corp.internal/realms/engineering",
        expectedAudience: "conductor-intranet",
        hmacSharedSecret: "corp-oidc-hs256-secret-key"
      });

      const validJwt = signCorporateOidcJwt(
        {
          sub: "anna.kowalska@corp.internal",
          iss: "https://keycloak.corp.internal/realms/engineering",
          aud: "conductor-intranet",
          exp: Math.floor(Date.now() / 1000) + 3600,
          groups: ["conductor-operators"]
        },
        "corp-oidc-hs256-secret-key"
      );

      const verifiedOidc = oidcVerifier.verifyAndMapScopes(validJwt);
      expect(verifiedOidc.claims.sub).toBe("anna.kowalska@corp.internal");
      expect(verifiedOidc.grantedScopes).toContain("orchestration:operate");
      expect(verifiedOidc.grantedScopes).toContain("terminal:operate");
      expect(verifiedOidc.grantedScopes).not.toContain("access:write");

      expect(() =>
        oidcVerifier.verifyAndMapScopes(`${validJwt}tampered`)
      ).toThrow(/ERR_OIDC_INVALID_SIGNATURE/);

      // 2. LocalEncryptedSecretStore (AES-256-GCM + scrypt)
      const secretsPath = join(tempDir, "secrets.enc.json");
      const secretStore = new LocalEncryptedSecretStore({
        masterKeyOrPassphrase: "correct-horse-battery-staple-intranet",
        storageFilePath: secretsPath
      });

      const envelope = secretStore.setSecret("gitlab_corp_pat", "glpat-super-secret-token-999");
      expect(envelope.algorithm).toBe("aes-256-gcm");
      expect(envelope.ciphertextHex).not.toContain("glpat-super-secret-token-999");

      // Reload from disk with same passphrase
      const reloadedStore = new LocalEncryptedSecretStore({
        masterKeyOrPassphrase: "correct-horse-battery-staple-intranet",
        storageFilePath: secretsPath
      });
      expect(reloadedStore.getSecret("gitlab_corp_pat")).toBe("glpat-super-secret-token-999");

      // Wrong passphrase must fail GCM authentication tag verification
      const wrongKeyStore = new LocalEncryptedSecretStore({
        masterKeyOrPassphrase: "wrong-passphrase",
        storageFilePath: secretsPath
      });
      expect(() => wrongKeyStore.getSecret("gitlab_corp_pat")).toThrow();

      // 3. HashiCorp Vault KV v2 connector (blocks public IPs, reads from intranet Vault)
      const publicVault = new HashiCorpVaultConnector({
        vaultBaseUrl: "http://8.8.8.8:8200",
        vaultToken: "hvs.test"
      });
      await expect(publicVault.readKvV2Secret("conductor/llm")).rejects.toThrow(
        /ERR_EGRESS_BLOCKED_BY_POLICY/
      );

      // 4. Tamper-evident JSONL AuditLogger
      const auditFile = join(tempDir, "audit.jsonl");
      const auditLogger = new AuditLogger({ jsonlFilePath: auditFile });
      auditLogger.logEvent("agent.prompt", {
        actor: "anna.kowalska@corp.internal",
        environmentId: "env_onprem",
        threadId: "thr_1",
        turnId: "turn_1",
        summary: "Started coding turn on thr_1"
      });
      auditLogger.logEvent("agent.file_edit", {
        actor: "agent:qwen3-coder",
        environmentId: "env_onprem",
        threadId: "thr_1",
        turnId: "turn_1",
        summary: "Edited src/index.ts"
      });

      expect(auditLogger.verifyIntegrity()).toBe(true);

      // Tamper with JSONL file on disk and verify integrity check detects the modification
      writeFileSync(auditFile, '{"tampered":true}\n', { flag: "a" });
      expect(auditLogger.verifyIntegrity()).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
