import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeMode } from "@conductor/contracts";
import { NetworkPolicyEvaluator } from "@conductor/network-guard";
import {
  resolveEffectiveModel,
  resolveSupportedRuntimeMode,
  type ProviderApprovalRequest,
  type ProviderApprovalResolution,
  type ProviderHost,
  type ProviderRegistry
} from "@conductor/provider-core";
import type { CheckpointStore } from "../checkpointing/CheckpointStore.js";
import type { EffectWorker } from "../orchestration-v2/EffectWorker.js";
import type { OrchestratorV2 } from "../orchestration-v2/Orchestrator.js";
import type { EventSink } from "../persistence/EventSink.js";

export interface ProviderTurnRunnerOptions {
  readonly environmentId: string;
  readonly sink: EventSink;
  readonly orchestrator: OrchestratorV2;
  readonly effectWorker: EffectWorker;
  readonly registry: ProviderRegistry;
  readonly checkpointStore: CheckpointStore;
  readonly networkEvaluator?: NetworkPolicyEvaluator;
}

/**
 * Connects `EffectWorker` outbox effects (`provider.run_turn`, `provider.cancel_turn`,
 * `checkpoint.restore`) to `ProviderRegistry` adapters, `CheckpointStore`, and `OrchestratorV2`.
 * Implements the `ProviderHost` boundary so provider packages never import `apps/server`.
 */
export class ProviderTurnRunner {
  private readonly environmentId: string;
  private readonly sink: EventSink;
  private readonly orchestrator: OrchestratorV2;
  private readonly effectWorker: EffectWorker;
  private readonly registry: ProviderRegistry;
  private readonly checkpointStore: CheckpointStore;
  private readonly networkEvaluator: NetworkPolicyEvaluator;
  private readonly activeTurnControllers = new Map<string, AbortController>();

  constructor(options: ProviderTurnRunnerOptions) {
    this.environmentId = options.environmentId;
    this.sink = options.sink;
    this.orchestrator = options.orchestrator;
    this.effectWorker = options.effectWorker;
    this.registry = options.registry;
    this.checkpointStore = options.checkpointStore;
    this.networkEvaluator = options.networkEvaluator ?? new NetworkPolicyEvaluator();

    this.registerEffectHandlers();
  }

  private turnKey(threadId: string, turnId: string): string {
    return `${threadId}:${turnId}`;
  }

  private registerEffectHandlers(): void {
    this.effectWorker.registerHandler("provider.run_turn", async (effect) => {
      const p = effect.payload as {
        threadId: string;
        turnId: string;
        projectId: string;
        prompt: string;
        providerInstanceId: string;
        model: string;
        runtimeMode: RuntimeMode;
      };

      await this.handleRunTurn(p);
    });

    this.effectWorker.registerHandler("provider.cancel_turn", async (effect) => {
      const p = effect.payload as {
        threadId: string;
        turnId: string;
      };
      await this.handleCancelTurn(p.threadId, p.turnId);
    });

    this.effectWorker.registerHandler("checkpoint.restore", async (effect) => {
      const p = effect.payload as {
        threadId: string;
        projectId: string;
        targetTurnId: string;
        checkpointRef: string;
        providerInstanceId: string;
      };
      const project = this.sink.getProject(p.projectId);
      if (!project) {
        throw new Error(`Project '${p.projectId}' not found for checkpoint restore`);
      }
      const adapter = this.registry.getInstance(p.providerInstanceId);
      const supportsRollback = adapter?.presentation.capabilities.rollback ?? true;
      this.checkpointStore.restoreCheckpoint(project.rootPath, p.checkpointRef, {
        providerSupportsRollback: supportsRollback
      });
    });
  }

  public createHostForThread(): ProviderHost {
    return {
      emitStreamEvent: (ev) => {
        this.sink.appendStreamEvents([
          {
            streamId: ev.streamId,
            type: ev.type,
            payload: ev.payload,
            createdAt: new Date().toISOString()
          }
        ]);
      },
      requestApproval: (req: ProviderApprovalRequest, signal?: AbortSignal) => {
        return new Promise<ProviderApprovalResolution>((resolve, reject) => {
          if (signal?.aborted) {
            reject(new Error("Turn aborted before approval request could be opened"));
            return;
          }

          let unsubscribe: (() => void) | undefined;

          const onAbort = () => {
            unsubscribe?.();
            reject(new Error("Turn aborted while awaiting approval"));
          };

          signal?.addEventListener("abort", onAbort, { once: true });

          unsubscribe = this.sink.subscribe(req.threadId, (events) => {
            for (const event of events) {
              if (
                event.type === "runtime-request.resolved" &&
                event.payload.requestId === req.requestId
              ) {
                signal?.removeEventListener("abort", onAbort);
                unsubscribe?.();
                resolve({
                  selectedOptionId: String(event.payload.selectedOptionId),
                  messageReply: event.payload.messageReply
                    ? String(event.payload.messageReply)
                    : undefined
                });
                return;
              }
            }
          });

          this.sink.appendStreamEvents([
            {
              streamId: req.threadId,
              type: "runtime-request.opened",
              payload: {
                threadId: req.threadId,
                turnId: req.turnId,
                requestId: req.requestId,
                question: req.question,
                options: req.options
              },
              createdAt: new Date().toISOString()
            }
          ]);
        });
      },
      verifyOutboundUrl: async (url) => {
        await this.networkEvaluator.verifyUrl(url);
      },
      getThreadMcpEndpoint: (threadId, modeLimit) => ({
        url: `http://127.0.0.1:4310/mcp?threadId=${encodeURIComponent(threadId)}`,
        headers: {
          "T3-Mode-Limit": modeLimit
        }
      })
    };
  }

  private buildThreadHistory(
    threadId: string,
    currentTurnId: string
  ): Array<{ readonly role: "user" | "assistant"; readonly content: string }> {
    const events = this.sink.getEventsForStream(threadId, 0);
    const turnOrder: string[] = [];
    const userPrompts = new Map<string, string>();
    const assistantDeltas = new Map<string, string[]>();

    for (const ev of events) {
      const tId = typeof ev.payload.turnId === "string" ? ev.payload.turnId : undefined;
      if (!tId || tId === currentTurnId) {
        continue;
      }
      if (ev.type === "turn.started" && typeof ev.payload.prompt === "string") {
        if (!userPrompts.has(tId)) {
          turnOrder.push(tId);
        }
        userPrompts.set(tId, ev.payload.prompt);
      } else if (ev.type === "message.delta" && typeof ev.payload.textDelta === "string") {
        const list = assistantDeltas.get(tId) ?? [];
        list.push(ev.payload.textDelta);
        assistantDeltas.set(tId, list);
      }
    }

    const history: Array<{ readonly role: "user" | "assistant"; readonly content: string }> = [];
    for (const tId of turnOrder) {
      const prompt = userPrompts.get(tId);
      if (prompt) {
        history.push({ role: "user", content: prompt });
      }
      const reply = (assistantDeltas.get(tId) ?? []).join("");
      if (reply) {
        history.push({ role: "assistant", content: reply });
      }
    }
    return history;
  }

  private findLatestCheckpointRef(threadId: string, excludeTurnId: string): string | undefined {
    const turns = this.sink.listTurnsForThread(threadId);
    let latest: string | undefined;
    for (const turn of turns) {
      if (turn.turnId !== excludeTurnId && turn.checkpointRef) {
        latest = turn.checkpointRef;
      }
    }
    return latest;
  }

  private async handleRunTurn(params: {
    readonly threadId: string;
    readonly turnId: string;
    readonly projectId: string;
    readonly prompt: string;
    readonly providerInstanceId: string;
    readonly model: string;
    readonly runtimeMode: RuntimeMode;
  }): Promise<void> {
    const { threadId, turnId, projectId, prompt, providerInstanceId } = params;
    const project = this.sink.getProject(projectId);
    if (!project) {
      throw new Error(`Project '${projectId}' not found`);
    }

    const adapter = this.registry.getInstance(providerInstanceId);
    if (!adapter) {
      this.orchestrator.dispatch({
        commandId: `cmd_finalize_${turnId}_missing_provider`,
        environmentId: this.environmentId,
        issuedAt: new Date().toISOString(),
        type: "turn.finalize",
        payload: {
          threadId,
          turnId,
          status: "failed",
          errorMessage: `Provider instance '${providerInstanceId}' is not registered`
        }
      });
      return;
    }

    const driver = this.registry.getDriver(adapter.instanceSettings.driverKind);
    const effectiveModel = resolveEffectiveModel(
      params.model,
      adapter.instanceSettings,
      driver?.fallbackDefaultModel ?? "local-default"
    );
    const effectiveMode = resolveSupportedRuntimeMode(params.runtimeMode, adapter.presentation);
    const history = this.buildThreadHistory(threadId, turnId);

    const key = this.turnKey(threadId, turnId);
    const controller = new AbortController();
    this.activeTurnControllers.set(key, controller);

    const host = this.createHostForThread();

    try {
      const outcome = await adapter.runTurn(
        {
          threadId,
          turnId,
          projectId,
          workspaceRoot: project.rootPath,
          prompt,
          model: effectiveModel,
          runtimeMode: effectiveMode,
          history
        },
        host,
        controller.signal
      );

      // Check if turn was already finalized (e.g., via turn.cancel command)
      const currentTurn = this.sink.getTurn(turnId);
      if (currentTurn && currentTurn.status !== "running") {
        return;
      }

      let checkpointRef: string | undefined;
      let diffSummary:
        | {
            readonly filesChanged: number;
            readonly insertions: number;
            readonly deletions: number;
          }
        | undefined;

      if (
        outcome.status === "completed" &&
        existsSync(join(project.rootPath, ".git"))
      ) {
        const previousCheckpointRef = this.findLatestCheckpointRef(threadId, turnId);
        const ckpt = this.checkpointStore.captureCheckpoint({
          repoPath: project.rootPath,
          threadId,
          turnId,
          previousCheckpointRef
        });
        checkpointRef = ckpt.checkpointRef;
        diffSummary = ckpt.diffSummary;
      }

      this.orchestrator.dispatch({
        commandId: `cmd_finalize_${turnId}`,
        environmentId: this.environmentId,
        issuedAt: new Date().toISOString(),
        type: "turn.finalize",
        payload: {
          threadId,
          turnId,
          status: outcome.status,
          checkpointRef,
          diffSummary,
          errorMessage: outcome.errorMessage
        }
      });
    } finally {
      this.activeTurnControllers.delete(key);
    }
  }

  public async handleCancelTurn(threadId: string, turnId: string): Promise<void> {
    const key = this.turnKey(threadId, turnId);
    const controller = this.activeTurnControllers.get(key);
    if (controller) {
      controller.abort();
    }
    const thread = this.sink.getThread(threadId);
    if (thread) {
      const adapter = this.registry.getInstance(thread.providerInstanceId);
      if (adapter) {
        await adapter.cancelTurn(threadId, turnId);
      }
    }
  }
}
