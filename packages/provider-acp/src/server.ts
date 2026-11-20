import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { DEFAULT_MODEL_SENTINEL, type ProviderPresentation } from "@conductor/contracts";
import { sanitizeSubprocessEnv } from "@conductor/network-guard";
import type {
  ProviderAdapterV2,
  ProviderDriver,
  ProviderHost,
  ProviderStatusReport,
  ProviderTurnInput,
  ProviderTurnOutcome
} from "@conductor/provider-core";
import { AcpSessionRuntime } from "./session-runtime.js";
import {
  ACP_PROVIDER_PRESENTATION,
  deriveAcpPresentationFromSessionModes,
  type AcpProviderSettings
} from "./settings.js";

export interface AcpAdapterFrameObserver {
  readonly onOutboundFrame?: (frame: Record<string, unknown>, threadId: string) => void;
  readonly onInboundFrame?: (frame: Record<string, unknown>, threadId: string) => void;
}

/**
 * Specification-compliant Agent Client Protocol (ACP) v1 ProviderAdapterV2.
 *
 * Maintains a pool of long-lived `AcpSessionRuntime` child processes keyed by `threadId`
 * so multi-turn conversations reuse the same process and `sessionId`, and supports
 * `session/load` resumption across server restarts.
 */
export class AcpProviderAdapter implements ProviderAdapterV2<AcpProviderSettings> {
  public readonly instanceSettings: AcpProviderSettings;
  private currentPresentation: ProviderPresentation = ACP_PROVIDER_PRESENTATION;
  private readonly sessions = new Map<string, AcpSessionRuntime>();
  private readonly frameObserver?: AcpAdapterFrameObserver;

  constructor(instanceSettings: AcpProviderSettings, frameObserver?: AcpAdapterFrameObserver) {
    this.instanceSettings = instanceSettings;
    this.frameObserver = frameObserver;
  }

  public get presentation(): ProviderPresentation {
    return this.currentPresentation;
  }

  public getSessionRuntime(threadId: string): AcpSessionRuntime | undefined {
    return this.sessions.get(threadId);
  }

  public listActiveThreadIds(): readonly string[] {
    return [...this.sessions.keys()];
  }

  public async probeStatus(): Promise<ProviderStatusReport> {
    const cmd = this.instanceSettings.config.command;
    const resolvedModel =
      this.instanceSettings.defaultModel !== DEFAULT_MODEL_SENTINEL
        ? this.instanceSettings.defaultModel
        : "acp-local-default";

    if (cmd.startsWith("/") || cmd.startsWith("./") || cmd.startsWith("../") || /^[A-Za-z]:\\/.test(cmd)) {
      const exists = existsSync(cmd);
      return {
        instanceId: this.instanceSettings.instanceId,
        driverKind: "acp",
        healthy: exists,
        availableModels: [resolvedModel],
        detail: exists ? `Binary found at ${cmd}` : `Binary not found at ${cmd}`
      };
    }

    return new Promise<ProviderStatusReport>((resolve) => {
      const child = spawn(cmd, ["--version"], {
        env: sanitizeSubprocessEnv(
          {
            ...process.env,
            ...this.instanceSettings.config.env
          },
          {
            caBundlePath: this.instanceSettings.caBundlePath
          }
        ),
        stdio: "ignore"
      });

      child.on("error", (err) => {
        resolve({
          instanceId: this.instanceSettings.instanceId,
          driverKind: "acp",
          healthy: false,
          availableModels: [],
          detail: err.message
        });
      });

      child.on("close", (code) => {
        resolve({
          instanceId: this.instanceSettings.instanceId,
          driverKind: "acp",
          healthy: code === 0,
          availableModels: [resolvedModel],
          detail: code === 0 ? "ACP CLI ready" : `ACP CLI exited with code ${String(code)}`
        });
      });
    });
  }

  public async runTurn(
    input: ProviderTurnInput,
    host: ProviderHost,
    signal: AbortSignal
  ): Promise<ProviderTurnOutcome> {
    let runtime = this.sessions.get(input.threadId);
    if (!runtime) {
      runtime = new AcpSessionRuntime({
        threadId: input.threadId,
        settings: this.instanceSettings,
        onOutboundFrame: this.frameObserver?.onOutboundFrame
          ? (frame) => this.frameObserver?.onOutboundFrame?.(frame, input.threadId)
          : undefined,
        onInboundFrame: this.frameObserver?.onInboundFrame
          ? (frame) => this.frameObserver?.onInboundFrame?.(frame, input.threadId)
          : undefined
      });
      this.sessions.set(input.threadId, runtime);
    }

    const outcome = await runtime.runTurn(input, host, signal);

    const modes = runtime.getSessionModes();
    if (modes) {
      this.currentPresentation = deriveAcpPresentationFromSessionModes(
        ACP_PROVIDER_PRESENTATION,
        modes
      );
    }

    return outcome;
  }

  public async cancelTurn(threadId: string, _turnId: string): Promise<void> {
    const runtime = this.sessions.get(threadId);
    if (runtime) {
      await runtime.cancelActiveTurn();
    }
  }

  public async closeSession(threadId: string): Promise<void> {
    const runtime = this.sessions.get(threadId);
    if (runtime) {
      this.sessions.delete(threadId);
      await runtime.close();
    }
  }

  public async closeAll(): Promise<void> {
    const runtimes = [...this.sessions.values()];
    this.sessions.clear();
    for (const runtime of runtimes) {
      await runtime.close();
    }
  }
}

export const acpProviderDriver: ProviderDriver<AcpProviderSettings> = {
  driverKind: "acp",
  presentation: ACP_PROVIDER_PRESENTATION,
  fallbackDefaultModel: "acp-local-default",
  createAdapter: (settings) => new AcpProviderAdapter(settings)
};
