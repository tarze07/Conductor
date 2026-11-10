import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { sanitizeSubprocessEnv } from "@conductor/network-guard";
import {
  resolveEffectiveModel,
  resolveSupportedRuntimeMode,
  type ProviderAdapterV2,
  type ProviderDriver,
  type ProviderHost,
  type ProviderStatusReport,
  type ProviderTurnInput,
  type ProviderTurnOutcome
} from "@conductor/provider-core/server";
import {
  ACP_PROVIDER_PRESENTATION,
  type AcpProviderSettings
} from "./settings.js";

interface JsonRpcFrame {
  readonly jsonrpc: "2.0";
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: number; readonly message: string };
}

export class AcpProviderAdapter implements ProviderAdapterV2<AcpProviderSettings> {
  public readonly instanceSettings: AcpProviderSettings;
  public readonly presentation = ACP_PROVIDER_PRESENTATION;
  private readonly activeProcesses = new Map<string, ChildProcessWithoutNullStreams>();

  constructor(instanceSettings: AcpProviderSettings) {
    this.instanceSettings = instanceSettings;
  }

  /**
   * Status check verifies binary configurability without opening an interactive session
   * or triggering external hooks (matching t3code's `providers.md` rule).
   */
  public async probeStatus(): Promise<ProviderStatusReport> {
    return {
      instanceId: this.instanceSettings.instanceId,
      driverKind: "acp",
      healthy: Boolean(this.instanceSettings.config.command),
      availableModels: [
        this.instanceSettings.defaultModel === "__DEFAULT_MODEL__"
          ? "acp-local-default"
          : this.instanceSettings.defaultModel
      ]
    };
  }

  public async runTurn(
    input: ProviderTurnInput,
    host: ProviderHost,
    signal: AbortSignal
  ): Promise<ProviderTurnOutcome> {
    if (signal.aborted) {
      return {
        status: "cancelled",
        assistantText: "",
        toolCallsCount: 0
      };
    }

    const effectiveModel = resolveEffectiveModel(
      input.model,
      this.instanceSettings,
      "acp-local-default"
    );
    const effectiveMode = resolveSupportedRuntimeMode(input.runtimeMode, this.presentation);

    const mcpBridge = host.getThreadMcpEndpoint?.(input.threadId, effectiveMode);
    const sanitizedEnv = sanitizeSubprocessEnv(process.env, {
      allowedEnvKeys: this.instanceSettings.config.allowedEnvKeys,
      caBundlePath: this.instanceSettings.caBundlePath,
      overrides: {
        CONDUCTOR_THREAD_ID: input.threadId,
        CONDUCTOR_RUNTIME_MODE: effectiveMode,
        ...(mcpBridge ? { CONDUCTOR_MCP_URL: mcpBridge.url } : {})
      }
    });

    const turnKey = `${input.threadId}:${input.turnId}`;
    const child = spawn(
      this.instanceSettings.config.command,
      this.instanceSettings.config.args,
      {
        cwd: input.workspaceRoot,
        env: sanitizedEnv,
        stdio: ["pipe", "pipe", "pipe"]
      }
    );

    this.activeProcesses.set(turnKey, child);

    let assistantText = "";
    let toolCallsCount = 0;
    let settled = false;

    const sendFrame = (frame: JsonRpcFrame): void => {
      if (!child.killed && child.stdin.writable) {
        child.stdin.write(`${JSON.stringify(frame)}\n`);
      }
    };

    const onAbort = (): void => {
      sendFrame({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { threadId: input.threadId, turnId: input.turnId }
      });
      child.kill("SIGTERM");
    };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      return await new Promise<ProviderTurnOutcome>((resolveOutcome) => {
        const rl = createInterface({ input: child.stdout });

        const finish = (outcome: ProviderTurnOutcome): void => {
          if (settled) {
            return;
          }
          settled = true;
          rl.close();
          if (!child.killed) {
            child.kill("SIGTERM");
          }
          resolveOutcome(outcome);
        };

        rl.on("line", (line) => {
          const trimmed = line.trim();
          if (!trimmed) {
            return;
          }
          let frame: JsonRpcFrame;
          try {
            frame = JSON.parse(trimmed) as JsonRpcFrame;
          } catch {
            return;
          }

          if (frame.method === "session/update" && frame.params) {
            const p = frame.params;
            if (p.updateType === "delta" && typeof p.textDelta === "string") {
              assistantText += p.textDelta;
              host.emitStreamEvent({
                streamId: input.threadId,
                type: "message.delta",
                payload: {
                  threadId: input.threadId,
                  turnId: input.turnId,
                  textDelta: p.textDelta
                }
              });
            } else if (p.updateType === "tool_call") {
              toolCallsCount += 1;
              host.emitStreamEvent({
                streamId: input.threadId,
                type: "tool.call.started",
                payload: {
                  threadId: input.threadId,
                  turnId: input.turnId,
                  toolCallId: String(p.toolCallId ?? `acp_tc_${toolCallsCount}`),
                  toolName: String(p.toolName ?? "acp_tool"),
                  args: (p.args as Record<string, unknown>) ?? {}
                }
              });
              host.emitStreamEvent({
                streamId: input.threadId,
                type: "tool.call.completed",
                payload: {
                  threadId: input.threadId,
                  turnId: input.turnId,
                  toolCallId: String(p.toolCallId ?? `acp_tc_${toolCallsCount}`),
                  toolName: String(p.toolName ?? "acp_tool"),
                  result: (p.result as Record<string, unknown>) ?? {}
                }
              });
            }
            return;
          }

          if (frame.method === "session/request_permission" && frame.params && frame.id !== undefined) {
            const p = frame.params;
            const requestId = String(p.requestId ?? `acp_perm_${frame.id}`);
            const options =
              (p.options as Array<{ id: string; label: string }>) ?? [
                { id: "allow", label: "Allow" },
                { id: "decline", label: "Decline" }
              ];
            void host
              .requestApproval(
                {
                  requestId,
                  threadId: input.threadId,
                  turnId: input.turnId,
                  question: String(p.question ?? "Approve ACP tool action?"),
                  options
                },
                signal
              )
              .then((res) => {
                sendFrame({
                  jsonrpc: "2.0",
                  id: frame.id,
                  result: { selectedOptionId: res.selectedOptionId }
                });
              })
              .catch(() => {
                sendFrame({
                  jsonrpc: "2.0",
                  id: frame.id,
                  result: { selectedOptionId: "decline" }
                });
              });
            return;
          }

          if (frame.id === "req_prompt" && frame.result) {
            const status =
              (frame.result.status as ProviderTurnOutcome["status"]) ?? "completed";
            finish({
              status,
              assistantText:
                typeof frame.result.assistantText === "string"
                  ? frame.result.assistantText
                  : assistantText,
              toolCallsCount
            });
          } else if (frame.id === "req_prompt" && frame.error) {
            finish({
              status: "failed",
              assistantText,
              toolCallsCount,
              errorMessage: frame.error.message
            });
          }
        });

        child.on("close", (code) => {
          if (!settled) {
            if (signal.aborted) {
              finish({
                status: "cancelled",
                assistantText,
                toolCallsCount
              });
            } else {
              finish({
                status: code === 0 ? "completed" : "failed",
                assistantText,
                toolCallsCount,
                errorMessage: code === 0 ? undefined : `ACP subprocess exited with code ${code}`
              });
            }
          }
        });

        // Send ACP initialize + session/prompt frames
        sendFrame({
          jsonrpc: "2.0",
          id: "req_init",
          method: "initialize",
          params: {
            protocolVersion: 1,
            flavor: this.instanceSettings.config.flavor,
            mcpEntryName: `conductor-${input.threadId}`
          }
        });

        sendFrame({
          jsonrpc: "2.0",
          id: "req_prompt",
          method: "session/prompt",
          params: {
            threadId: input.threadId,
            turnId: input.turnId,
            prompt: input.prompt,
            model: effectiveModel,
            runtimeMode: effectiveMode
          }
        });
      });
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.activeProcesses.delete(turnKey);
    }
  }

  public async cancelTurn(threadId: string, turnId: string): Promise<void> {
    const child = this.activeProcesses.get(`${threadId}:${turnId}`);
    if (child && !child.killed) {
      child.kill("SIGTERM");
    }
  }
}

export const acpProviderDriver: ProviderDriver<AcpProviderSettings> = {
  driverKind: "acp",
  presentation: ACP_PROVIDER_PRESENTATION,
  fallbackDefaultModel: "acp-local-default",
  createAdapter(settings) {
    return new AcpProviderAdapter(settings);
  }
};
