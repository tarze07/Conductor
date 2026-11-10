import { z } from "zod";
import {
  makeProviderSettingsSchema,
  type ProviderPresentation
} from "@conductor/contracts";
import {
  resolveEffectiveModel,
  resolveSupportedRuntimeMode,
  type ProviderAdapterV2,
  type ProviderDriver,
  type ProviderHost,
  type ProviderStatusReport,
  type ProviderTurnInput,
  type ProviderTurnOutcome
} from "./server.js";

export type ReplayScenarioName =
  | "simple"
  | "multi_turn"
  | "queued_turn"
  | "turn_interrupt"
  | "message_steering"
  | "provider_thread_resume"
  | "tool_call_approval"
  | "usage_limit";

export type ReplayStep =
  | { readonly kind: "delta"; readonly textDelta: string }
  | {
      readonly kind: "tool_call";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args: Record<string, unknown>;
      readonly result: Record<string, unknown>;
    }
  | {
      readonly kind: "approval";
      readonly requestId: string;
      readonly question: string;
      readonly options: readonly { readonly id: string; readonly label: string }[];
      readonly declineOptionId: string;
    }
  | { readonly kind: "wait_for_abort" }
  | { readonly kind: "usage_limit"; readonly resetAt: string };

export interface ReplayFixture {
  readonly scenario: ReplayScenarioName;
  readonly steps: readonly ReplayStep[];
}

export const ReplayProviderSettingsSchema = makeProviderSettingsSchema("replay", {
  defaultScenario: z.string().default("simple")
});
export type ReplayProviderSettings = z.infer<typeof ReplayProviderSettingsSchema>;

export const REPLAY_PROVIDER_PRESENTATION: ProviderPresentation = {
  driverKind: "replay",
  label: "Replay (Deterministic Offline Testkit)",
  badge: "DEV",
  supportedRuntimeModes: ["plan-only", "supervised", "autonomous-sandbox"],
  showInteractionModeToggle: true,
  capabilities: {
    fork: true,
    rollback: true,
    steering: true,
    subagents: true,
    nativeCheckpoints: false,
    streamingToolCalls: true
  }
};

export const BUILT_IN_REPLAY_FIXTURES: Readonly<Record<ReplayScenarioName, ReplayFixture>> =
  Object.freeze({
    simple: {
      scenario: "simple",
      steps: [
        { kind: "delta", textDelta: "Analizuję projekt lokalnie... " },
        { kind: "delta", textDelta: "Gotowe." }
      ]
    },
    multi_turn: {
      scenario: "multi_turn",
      steps: [
        {
          kind: "tool_call",
          toolCallId: "tc_read_1",
          toolName: "read_file",
          args: { path: "README.md" },
          result: { content: "# Conductor" }
        },
        { kind: "delta", textDelta: "Odczytałem README.md i zaktualizowałem kontekst." }
      ]
    },
    queued_turn: {
      scenario: "queued_turn",
      steps: [{ kind: "delta", textDelta: "Kolejna tura z kolejki wykonana." }]
    },
    turn_interrupt: {
      scenario: "turn_interrupt",
      steps: [
        { kind: "delta", textDelta: "Rozpoczynam długą operację..." },
        { kind: "wait_for_abort" }
      ]
    },
    message_steering: {
      scenario: "message_steering",
      steps: [{ kind: "delta", textDelta: "Uwzględniono korektę kursu (steering)." }]
    },
    provider_thread_resume: {
      scenario: "provider_thread_resume",
      steps: [{ kind: "delta", textDelta: "Wznowiono sesję wątku z historii." }]
    },
    tool_call_approval: {
      scenario: "tool_call_approval",
      steps: [
        {
          kind: "approval",
          requestId: "req_approve_cmd_1",
          question: "Czy zezwolić na wykonanie `pnpm test` w przestrzeni roboczej?",
          options: [
            { id: "allow-once", label: "Zezwól raz" },
            { id: "decline", label: "Odrzuć" }
          ],
          declineOptionId: "decline"
        },
        {
          kind: "tool_call",
          toolCallId: "tc_bash_1",
          toolName: "run_terminal_command",
          args: { command: "pnpm test" },
          result: { exitCode: 0 }
        },
        { kind: "delta", textDelta: "Testy zakończone sukcesem." }
      ]
    },
    usage_limit: {
      scenario: "usage_limit",
      steps: [
        {
          kind: "usage_limit",
          resetAt: "2026-11-10T12:00:00.000Z"
        }
      ]
    }
  });

export class ReplayProviderAdapter implements ProviderAdapterV2<ReplayProviderSettings> {
  public readonly instanceSettings: ReplayProviderSettings;
  public readonly presentation = REPLAY_PROVIDER_PRESENTATION;
  private readonly fixtures: Map<string, ReplayFixture>;
  private readonly activeAbortControllers = new Map<string, AbortController>();

  constructor(
    instanceSettings: ReplayProviderSettings,
    customFixtures: Readonly<Record<string, ReplayFixture>> = BUILT_IN_REPLAY_FIXTURES
  ) {
    this.instanceSettings = instanceSettings;
    this.fixtures = new Map(Object.entries(customFixtures));
  }

  public async probeStatus(): Promise<ProviderStatusReport> {
    return {
      instanceId: this.instanceSettings.instanceId,
      driverKind: "replay",
      healthy: true,
      availableModels: ["replay-deterministic-v1"]
    };
  }

  public async runTurn(
    input: ProviderTurnInput,
    host: ProviderHost,
    signal: AbortSignal
  ): Promise<ProviderTurnOutcome> {
    const effectiveModel = resolveEffectiveModel(
      input.model,
      this.instanceSettings,
      "replay-deterministic-v1"
    );
    const effectiveMode = resolveSupportedRuntimeMode(input.runtimeMode, this.presentation);

    const turnKey = `${input.threadId}:${input.turnId}`;
    const internalAbort = new AbortController();
    this.activeAbortControllers.set(turnKey, internalAbort);

    const onExternalAbort = () => internalAbort.abort();
    signal.addEventListener("abort", onExternalAbort, { once: true });

    try {
      if (signal.aborted || internalAbort.signal.aborted) {
        return {
          status: "cancelled",
          assistantText: "",
          toolCallsCount: 0
        };
      }

      const scenarioKey =
        (input.prompt.startsWith("scenario:")
          ? input.prompt.slice("scenario:".length).trim()
          : this.instanceSettings.config.defaultScenario) || "simple";
      const fixture = this.fixtures.get(scenarioKey) ?? BUILT_IN_REPLAY_FIXTURES.simple;

      let assistantText = "";
      let toolCallsCount = 0;

      for (const step of fixture.steps) {
        if (internalAbort.signal.aborted) {
          return {
            status: "cancelled",
            assistantText,
            toolCallsCount
          };
        }

        switch (step.kind) {
          case "delta": {
            assistantText += step.textDelta;
            host.emitStreamEvent({
              streamId: input.threadId,
              type: "message.delta",
              payload: {
                threadId: input.threadId,
                turnId: input.turnId,
                model: effectiveModel,
                runtimeMode: effectiveMode,
                textDelta: step.textDelta
              }
            });
            break;
          }

          case "tool_call": {
            toolCallsCount += 1;
            host.emitStreamEvent({
              streamId: input.threadId,
              type: "tool.call.started",
              payload: {
                threadId: input.threadId,
                turnId: input.turnId,
                toolCallId: step.toolCallId,
                toolName: step.toolName,
                args: step.args
              }
            });
            host.emitStreamEvent({
              streamId: input.threadId,
              type: "tool.call.completed",
              payload: {
                threadId: input.threadId,
                turnId: input.turnId,
                toolCallId: step.toolCallId,
                toolName: step.toolName,
                result: step.result
              }
            });
            break;
          }

          case "approval": {
            const resolution = await host.requestApproval(
              {
                requestId: step.requestId,
                threadId: input.threadId,
                turnId: input.turnId,
                question: step.question,
                options: step.options
              },
              internalAbort.signal
            );
            if (resolution.selectedOptionId === step.declineOptionId) {
              return {
                status: "cancelled",
                assistantText: `${assistantText}[Operacja odrzucona przez użytkownika]`,
                toolCallsCount
              };
            }
            break;
          }

          case "wait_for_abort": {
            await new Promise<void>((resolve) => {
              if (internalAbort.signal.aborted) {
                resolve();
                return;
              }
              internalAbort.signal.addEventListener("abort", () => resolve(), { once: true });
            });
            return {
              status: "cancelled",
              assistantText,
              toolCallsCount
            };
          }

          case "usage_limit": {
            return {
              status: "usage_limit",
              assistantText,
              toolCallsCount,
              errorMessage: "Provider rate/quota limit reached",
              usageLimitResetAt: step.resetAt
            };
          }
        }
      }

      return {
        status: "completed",
        assistantText,
        toolCallsCount
      };
    } finally {
      signal.removeEventListener("abort", onExternalAbort);
      this.activeAbortControllers.delete(turnKey);
    }
  }

  public async cancelTurn(threadId: string, turnId: string): Promise<void> {
    const controller = this.activeAbortControllers.get(`${threadId}:${turnId}`);
    controller?.abort();
  }
}

export const replayProviderDriver: ProviderDriver<ReplayProviderSettings> = {
  driverKind: "replay",
  presentation: REPLAY_PROVIDER_PRESENTATION,
  fallbackDefaultModel: "replay-deterministic-v1",
  createAdapter(settings) {
    return new ReplayProviderAdapter(settings);
  }
};
