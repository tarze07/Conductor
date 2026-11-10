import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_SENTINEL } from "@conductor/contracts";
import {
  PathTraversalError,
  ResilientMcpClient,
  ThreadMcpBridge,
  narrowModeCeiling,
  resolveSafeWorkspacePath
} from "@conductor/agent-core";
import {
  ProviderRegistry,
  replayProviderDriver,
  resolveEffectiveModel,
  resolveSupportedRuntimeMode,
  type ReplayProviderSettings
} from "@conductor/provider-core";
import {
  localLlmClientDefinition,
  localLlmProviderDriver,
  startMockLocalLlmServer,
  type LocalLlmSettings
} from "@conductor/provider-local-llm";
import {
  acpProviderClientDefinition,
  acpProviderDriver,
  createMockAcpInstanceSettings
} from "@conductor/provider-acp";
import {
  CheckpointStore,
  EffectWorker,
  EventSink,
  OrchestratorV2,
  ProviderTurnRunner,
  SqliteStateStore
} from "./index.js";

describe("Phase 3 — Provider Driver vs Instance separation, DEFAULT_MODEL_SENTINEL, and RuntimePolicy", () => {
  it("supports multiple configured instances of the same driver and never sends DEFAULT_MODEL_SENTINEL over the wire", () => {
    const registry = new ProviderRegistry();
    registry.registerDriver(localLlmProviderDriver);
    registry.registerDriver(acpProviderDriver);

    expect(localLlmClientDefinition.driverKind).toBe("local-llm");
    expect(acpProviderClientDefinition.driverKind).toBe("acp");

    const vllmSettings: LocalLlmSettings = {
      instanceId: "vllm-coder-qwen3",
      driverKind: "local-llm",
      label: "Internal vLLM Cluster (Qwen3-Coder)",
      enabled: true,
      defaultModel: "Qwen/Qwen2.5-Coder-32B-Instruct",
      baseUrl: "http://10.20.30.40:8000/v1",
      config: {
        engineType: "vllm",
        apiFormat: "openai-compatible",
        maxSteps: 12,
        temperature: 0.1,
        stream: true
      }
    };

    const ollamaSettings: LocalLlmSettings = {
      instanceId: "ollama-local-workstation",
      driverKind: "local-llm",
      label: "Workstation Ollama",
      enabled: true,
      defaultModel: "deepseek-coder-v2:16b",
      baseUrl: "http://127.0.0.1:11434/v1",
      config: {
        engineType: "ollama",
        apiFormat: "openai-compatible",
        maxSteps: 12,
        temperature: 0.1,
        stream: true
      }
    };

    const vllmInstance = registry.registerInstance(vllmSettings);
    const ollamaInstance = registry.registerInstance(ollamaSettings);

    expect(registry.listInstances()).toHaveLength(2);
    expect(vllmInstance.instanceSettings.instanceId).toBe("vllm-coder-qwen3");
    expect(ollamaInstance.instanceSettings.instanceId).toBe("ollama-local-workstation");

    // Verify DEFAULT_MODEL_SENTINEL resolves to instance defaultModel or driver fallback
    expect(
      resolveEffectiveModel(
        DEFAULT_MODEL_SENTINEL,
        vllmInstance.instanceSettings,
        localLlmProviderDriver.fallbackDefaultModel
      )
    ).toBe("Qwen/Qwen2.5-Coder-32B-Instruct");

    expect(
      resolveEffectiveModel(
        DEFAULT_MODEL_SENTINEL,
        {
          instanceId: "inst_no_default",
          driverKind: "local-llm",
          label: "No Default",
          enabled: true,
          defaultModel: DEFAULT_MODEL_SENTINEL
        },
        localLlmProviderDriver.fallbackDefaultModel
      )
    ).toBe("qwen3-coder-30b");

    // Verify unoffered RuntimeMode falls back to "supervised"
    expect(
      resolveSupportedRuntimeMode("autonomous-sandbox", {
        ...vllmInstance.presentation,
        supportedRuntimeModes: ["plan-only", "supervised"]
      })
    ).toBe("supervised");
  });
});

describe("Phase 3 — Deterministic ReplayProviderAdapter harness through OrchestratorV2 and ProviderTurnRunner", () => {
  it("runs simple, tool_call_approval, and usage_limit scenarios deterministically", async () => {
    const store = new SqliteStateStore({ dbPath: ":memory:" });
    const sink = new EventSink(store);
    const orchestrator = new OrchestratorV2(sink);
    const worker = new EffectWorker(store);
    orchestrator.attachEffectWorker(worker);

    const registry = new ProviderRegistry();
    registry.registerDriver(replayProviderDriver);
    const replaySettings: ReplayProviderSettings = {
      instanceId: "replay-1",
      driverKind: "replay",
      label: "Deterministic Replay",
      enabled: true,
      defaultModel: "replay-model",
      config: {
        defaultScenario: "simple"
      }
    };
    registry.registerInstance(replaySettings);

    const checkpointStore = new CheckpointStore();
    new ProviderTurnRunner({
      environmentId: "env_replay",
      sink,
      orchestrator,
      effectWorker: worker,
      registry,
      checkpointStore
    });

    const tempWorkspace = mkdtempSync(join(tmpdir(), "conductor-replay-ws-"));

    try {
      orchestrator.dispatch({
        commandId: "cmd_proj",
        environmentId: "env_replay",
        issuedAt: "2026-11-10T11:00:00.000Z",
        type: "project.register",
        payload: {
          projectId: "proj_replay",
          name: "Replay Workspace",
          rootPath: tempWorkspace,
          defaultBranch: "main"
        }
      });

      orchestrator.dispatch({
        commandId: "cmd_thr",
        environmentId: "env_replay",
        issuedAt: "2026-11-10T11:00:01.000Z",
        type: "thread.create",
        payload: {
          threadId: "thr_replay",
          projectId: "proj_replay",
          title: "Replay Thread",
          providerInstanceId: "replay-1",
          model: DEFAULT_MODEL_SENTINEL,
          runtimeMode: "supervised"
        }
      });

      // 1. Simple turn
      orchestrator.dispatch({
        commandId: "cmd_t1",
        environmentId: "env_replay",
        issuedAt: "2026-11-10T11:00:02.000Z",
        type: "turn.start",
        payload: {
          threadId: "thr_replay",
          turnId: "turn_simple",
          prompt: "scenario:simple",
          attachmentIds: []
        }
      });
      await worker.drain();
      expect(sink.getTurn("turn_simple")?.status).toBe("completed");

      // 2. Tool call approval turn: subscribe and auto-approve when runtime-request.opened arrives
      const unsubscribe = sink.subscribe("thr_replay", (events) => {
        for (const ev of events) {
          if (ev.type === "runtime-request.opened") {
            orchestrator.dispatch({
              commandId: `cmd_approve_${String(ev.payload.requestId)}`,
              environmentId: "env_replay",
              issuedAt: new Date().toISOString(),
              type: "runtime-request.respond",
              payload: {
                threadId: "thr_replay",
                requestId: String(ev.payload.requestId),
                selectedOptionId: "allow-once"
              }
            });
          }
        }
      });

      orchestrator.dispatch({
        commandId: "cmd_t2",
        environmentId: "env_replay",
        issuedAt: "2026-11-10T11:00:05.000Z",
        type: "turn.start",
        payload: {
          threadId: "thr_replay",
          turnId: "turn_approval",
          prompt: "scenario:tool_call_approval",
          attachmentIds: []
        }
      });
      await worker.drain();
      unsubscribe();

      expect(sink.getTurn("turn_approval")?.status).toBe("completed");
      expect(sink.getRuntimeRequest("req_approve_cmd_1")?.status).toBe("resolved");
      expect(sink.getRuntimeRequest("req_approve_cmd_1")?.selectedOptionId).toBe("allow-once");

      // 3. Usage limit turn (distinct from generic failure)
      orchestrator.dispatch({
        commandId: "cmd_t3",
        environmentId: "env_replay",
        issuedAt: "2026-11-10T11:00:10.000Z",
        type: "turn.start",
        payload: {
          threadId: "thr_replay",
          turnId: "turn_quota",
          prompt: "scenario:usage_limit",
          attachmentIds: []
        }
      });
      await worker.drain();
      expect(sink.getTurn("turn_quota")?.status).toBe("usage_limit");
    } finally {
      store.close();
      rmSync(tempWorkspace, { recursive: true, force: true });
    }
  });
});

describe("Phase 3 — LocalLlmProviderAdapter + NativeAgentRuntime (SSE streaming, tools, approval gate, Git checkpoints, and Zero-Internet guard)", () => {
  it("executes a multi-step ReAct coding turn against a local OpenAI-compatible server, gates write_file in supervised mode, and captures a Git checkpoint", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "conductor-local-llm-repo-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Dev"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "dev@corp.internal"], { cwd: repoDir });
    writeFileSync(join(repoDir, "README.md"), "# Conductor Local Project\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });

    const mockServer = await startMockLocalLlmServer([
      // Step 1: Model streams SSE tool_calls for write_file to create src/math.ts
      {
        sseChunks: [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_write_1",
                      function: {
                        name: "write_file",
                        arguments: JSON.stringify({
                          path: "src/math.ts",
                          content: "export function add(a: number, b: number): number {\n  return a + b;\n}\n"
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
      // Step 2: Model streams final text response
      {
        sseChunks: [
          { choices: [{ delta: { content: "Utworzono plik " } }] },
          { choices: [{ delta: { content: "`src/math.ts` z funkcją `add`." } }] }
        ]
      }
    ]);

    const store = new SqliteStateStore({ dbPath: ":memory:" });
    const sink = new EventSink(store);
    const orchestrator = new OrchestratorV2(sink);
    const worker = new EffectWorker(store);
    orchestrator.attachEffectWorker(worker);

    const registry = new ProviderRegistry();
    registry.registerDriver(localLlmProviderDriver);
    const localSettings: LocalLlmSettings = {
      instanceId: "vllm-local-test",
      driverKind: "local-llm",
      label: "Local vLLM Test",
      enabled: true,
      defaultModel: "qwen3-coder-30b",
      baseUrl: mockServer.baseUrl,
      config: {
        engineType: "vllm",
        apiFormat: "openai-compatible",
        maxSteps: 12,
        temperature: 0.1,
        stream: true
      }
    };
    const adapter = registry.registerInstance(localSettings);

    const status = await adapter.probeStatus();
    expect(status.healthy).toBe(true);
    expect(status.availableModels).toContain("qwen3-coder-30b");

    const checkpointStore = new CheckpointStore();
    new ProviderTurnRunner({
      environmentId: "env_local_llm",
      sink,
      orchestrator,
      effectWorker: worker,
      registry,
      checkpointStore
    });

    try {
      orchestrator.dispatch({
        commandId: "cmd_reg_proj",
        environmentId: "env_local_llm",
        issuedAt: "2026-11-10T12:00:00.000Z",
        type: "project.register",
        payload: {
          projectId: "proj_math",
          name: "Math Repo",
          rootPath: repoDir,
          defaultBranch: "main"
        }
      });

      orchestrator.dispatch({
        commandId: "cmd_create_thr",
        environmentId: "env_local_llm",
        issuedAt: "2026-11-10T12:00:01.000Z",
        type: "thread.create",
        payload: {
          threadId: "thr_math",
          projectId: "proj_math",
          title: "Add math module",
          providerInstanceId: "vllm-local-test",
          model: DEFAULT_MODEL_SENTINEL,
          runtimeMode: "supervised"
        }
      });

      // Automatically approve the write_file permission prompt when it opens in supervised mode
      const approvalQuestions: string[] = [];
      sink.subscribe("thr_math", (events) => {
        for (const ev of events) {
          if (ev.type === "runtime-request.opened") {
            approvalQuestions.push(String(ev.payload.question));
            orchestrator.dispatch({
              commandId: `cmd_resp_${String(ev.payload.requestId)}`,
              environmentId: "env_local_llm",
              issuedAt: new Date().toISOString(),
              type: "runtime-request.respond",
              payload: {
                threadId: "thr_math",
                requestId: String(ev.payload.requestId),
                selectedOptionId: "allow-once"
              }
            });
          }
        }
      });

      orchestrator.dispatch({
        commandId: "cmd_start_turn",
        environmentId: "env_local_llm",
        issuedAt: "2026-11-10T12:00:02.000Z",
        type: "turn.start",
        payload: {
          threadId: "thr_math",
          turnId: "turn_math_1",
          prompt: "Stwórz src/math.ts z funkcją add",
          attachmentIds: []
        }
      });

      await worker.drain();

      expect(approvalQuestions).toHaveLength(1);
      expect(approvalQuestions[0]).toContain("write_file");

      // Verify file was written to workspace
      const mathFile = join(repoDir, "src/math.ts");
      expect(existsSync(mathFile)).toBe(true);
      expect(readFileSync(mathFile, "utf8")).toContain("export function add");

      // Verify DEFAULT_MODEL_SENTINEL was resolved before hitting the wire
      expect(mockServer.receivedRequests.length).toBeGreaterThanOrEqual(2);
      const firstBody = mockServer.receivedRequests[0]!.body as { model: string };
      expect(firstBody.model).toBe("qwen3-coder-30b");
      expect(firstBody.model).not.toBe(DEFAULT_MODEL_SENTINEL);

      // Verify automatic Git checkpoint was captured and recorded on the turn projection
      const turnRecord = sink.getTurn("turn_math_1");
      expect(turnRecord?.status).toBe("completed");
      expect(turnRecord?.checkpointRef).toBe("refs/conductor/checkpoints/thr_math/turn_math_1");
      expect(turnRecord?.diffSummary?.filesChanged).toBe(1);

      // Verify path traversal outside workspace root is rejected
      expect(() => resolveSafeWorkspacePath(repoDir, "../../etc/passwd")).toThrowError(
        PathTraversalError
      );
    } finally {
      await mockServer.close();
      store.close();
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("blocks outbound LocalLlmProviderAdapter requests if baseUrl points to a public IP", async () => {
    const registry = new ProviderRegistry();
    registry.registerDriver(localLlmProviderDriver);
    const badSettings: LocalLlmSettings = {
      instanceId: "public-llm-leak",
      driverKind: "local-llm",
      label: "Misconfigured Public IP",
      enabled: true,
      defaultModel: "qwen",
      baseUrl: "http://8.8.8.8:8000/v1",
      config: {
        engineType: "vllm",
        apiFormat: "openai-compatible",
        maxSteps: 4,
        temperature: 0.1,
        stream: true
      }
    };
    const badAdapter = registry.registerInstance(badSettings);

    const status = await badAdapter.probeStatus();
    expect(status.healthy).toBe(false);
    expect(status.detail).toContain("ERR_EGRESS_BLOCKED_BY_POLICY");
  });
});

describe("Phase 3 — AcpProviderAdapter over stdio JSON-RPC 2.0 with sanitized environment", () => {
  it("communicates with a local ACP CLI agent over stdio and strips ambient cloud API keys", async () => {
    process.env.OPENAI_API_KEY = "sk-should-never-reach-acp-child";

    const registry = new ProviderRegistry();
    registry.registerDriver(acpProviderDriver);
    const acpSettings = createMockAcpInstanceSettings("acp-local-1");
    const adapter = registry.registerInstance(acpSettings);

    const status = await adapter.probeStatus();
    expect(status.healthy).toBe(true);

    const emittedDeltas: string[] = [];
    const outcome = await adapter.runTurn(
      {
        threadId: "thr_acp",
        turnId: "turn_acp_1",
        projectId: "proj_acp",
        workspaceRoot: process.cwd(),
        prompt: "Sprawdź środowisko ACP",
        model: "acp-local-model",
        runtimeMode: "supervised"
      },
      {
        emitStreamEvent: (ev) => {
          if (ev.type === "message.delta" && typeof ev.payload.textDelta === "string") {
            emittedDeltas.push(ev.payload.textDelta);
          }
        },
        requestApproval: async () => ({ selectedOptionId: "allow" }),
        verifyOutboundUrl: async () => {}
      },
      new AbortController().signal
    );

    expect(outcome.status).toBe("completed");
    expect(emittedDeltas.join("")).toContain("ACP offline response (CLEAN)");

    delete process.env.OPENAI_API_KEY;
  });
});

describe("Phase 3 — ThreadMcpBridge (T3-Mode-Limit narrowing) and ResilientMcpClient", () => {
  it("narrows MCP capability ceiling via T3-Mode-Limit header and survives unreachable MCP servers", async () => {
    expect(narrowModeCeiling("autonomous-sandbox", "plan-only")).toBe("plan-only");
    expect(narrowModeCeiling("plan-only", "autonomous-sandbox")).toBe("plan-only");

    const bridge = new ThreadMcpBridge();
    bridge.registerTool({
      definition: {
        name: "conductor_get_thread_context",
        description: "Read current thread metadata",
        mutatesState: false,
        parametersJsonSchema: { type: "object", properties: {} }
      },
      requiredAccess: "orchestration:read",
      handler: async (_args, ctx) => ({ ok: true, threadId: ctx.threadId, mode: ctx.effectiveMode })
    });

    bridge.registerTool({
      definition: {
        name: "conductor_append_followup_prompt",
        description: "Queue a follow-up prompt on the thread",
        mutatesState: true,
        parametersJsonSchema: { type: "object", properties: { prompt: { type: "string" } } }
      },
      requiredAccess: "orchestration:operate",
      handler: async () => ({ ok: true })
    });

    // Read tool succeeds even when narrowed to plan-only via T3-Mode-Limit
    const readRes = await bridge.invokeTool({
      toolName: "conductor_get_thread_context",
      args: {},
      threadId: "thr_mcp_1",
      grantedAccess: ["orchestration:read", "orchestration:operate"],
      sessionCeiling: "autonomous-sandbox",
      headerModeLimit: "plan-only"
    });
    expect(readRes).toEqual({ ok: true, threadId: "thr_mcp_1", mode: "plan-only" });

    // Operate tool is denied when narrowed to plan-only via T3-Mode-Limit
    await expect(
      bridge.invokeTool({
        toolName: "conductor_append_followup_prompt",
        args: { prompt: "Run deploy" },
        threadId: "thr_mcp_1",
        grantedAccess: ["orchestration:read", "orchestration:operate"],
        sessionCeiling: "autonomous-sandbox",
        headerModeLimit: "plan-only"
      })
    ).rejects.toThrow(/ERR_MCP_MODE_CEILING/);

    // ResilientMcpClient must not throw when a user-configured MCP server is unreachable
    const resilientClient = new ResilientMcpClient([
      {
        serverName: "mcp-broken-intranet",
        listTools: async () => {
          throw new Error("Connection refused to 10.99.99.99:4310");
        },
        callTool: async () => {
          throw new Error("Connection refused");
        }
      }
    ]);

    const discovered = await resilientClient.discoverToolsSafe();
    expect(discovered).toHaveLength(0);

    const callRes = await resilientClient.callToolSafe("some_tool", {});
    expect(callRes.ok).toBe(false);
    expect(callRes.mcpUnreachable).toBe(true);
  });
});
