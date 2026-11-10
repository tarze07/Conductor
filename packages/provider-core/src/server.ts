import {
  DEFAULT_MODEL_SENTINEL,
  type BaseProviderInstanceSettings,
  type OrchestrationEventType,
  type ProviderPresentation,
  type RuntimeMode
} from "@conductor/contracts";

export interface ProviderTurnInput {
  readonly threadId: string;
  readonly turnId: string;
  readonly projectId: string;
  readonly workspaceRoot: string;
  readonly prompt: string;
  readonly model: string;
  readonly runtimeMode: RuntimeMode;
  readonly history?: readonly {
    readonly role: "user" | "assistant";
    readonly content: string;
  }[];
}

export interface ProviderTurnOutcome {
  readonly status: "completed" | "cancelled" | "failed" | "usage_limit";
  readonly assistantText: string;
  readonly toolCallsCount: number;
  readonly errorMessage?: string;
  readonly usageLimitResetAt?: string;
  readonly hasPendingBackgroundWork?: boolean;
}

export interface ProviderApprovalRequest {
  readonly requestId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly question: string;
  readonly options: readonly { readonly id: string; readonly label: string }[];
}

export interface ProviderApprovalResolution {
  readonly selectedOptionId: string;
  readonly messageReply?: string;
}

/**
 * Host boundary passed into provider adapters so adapters never import `apps/server` directly
 * (matching t3code's `ProviderHost` architecture in `docs/internals/adding-a-provider.md`).
 */
export interface ProviderHost {
  emitStreamEvent(event: {
    readonly streamId: string;
    readonly type: OrchestrationEventType;
    readonly payload: Record<string, unknown>;
  }): void;
  requestApproval(request: ProviderApprovalRequest, signal?: AbortSignal): Promise<ProviderApprovalResolution>;
  verifyOutboundUrl(url: string | URL): Promise<void>;
  getThreadMcpEndpoint?(threadId: string, modeLimit: RuntimeMode): {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
  };
}

export interface ProviderStatusReport {
  readonly instanceId: string;
  readonly driverKind: string;
  readonly healthy: boolean;
  readonly availableModels: readonly string[];
  readonly detail?: string;
}

export interface ProviderAdapterV2<
  TSettings extends BaseProviderInstanceSettings = BaseProviderInstanceSettings
> {
  readonly instanceSettings: TSettings;
  readonly presentation: ProviderPresentation;
  probeStatus(): Promise<ProviderStatusReport>;
  runTurn(
    input: ProviderTurnInput,
    host: ProviderHost,
    signal: AbortSignal
  ): Promise<ProviderTurnOutcome>;
  cancelTurn(threadId: string, turnId: string): Promise<void>;
}

export interface ProviderDriver<
  TSettings extends BaseProviderInstanceSettings = BaseProviderInstanceSettings
> {
  readonly driverKind: string;
  readonly presentation: ProviderPresentation;
  readonly fallbackDefaultModel: string;
  createAdapter(instanceSettings: TSettings): ProviderAdapterV2<TSettings>;
}

/**
 * Resolves the effective model name, ensuring the `DEFAULT_MODEL_SENTINEL` (`"__DEFAULT_MODEL__"`)
 * is never sent over the wire to a provider (matching t3code's "Default is a sentinel, not a model" rule).
 */
export function resolveEffectiveModel(
  requestedModel: string | undefined,
  instanceSettings: BaseProviderInstanceSettings,
  driverFallbackModel: string
): string {
  if (requestedModel && requestedModel !== DEFAULT_MODEL_SENTINEL) {
    return requestedModel;
  }
  if (
    instanceSettings.defaultModel &&
    instanceSettings.defaultModel !== DEFAULT_MODEL_SENTINEL
  ) {
    return instanceSettings.defaultModel;
  }
  return driverFallbackModel;
}

/**
 * Enforces t3code's RuntimePolicy rule:
 * "Offer only modes the provider enforces natively, through `supportedRuntimeModes` in the
 * provider presentation. The server runs an unoffered stored mode as Supervised."
 */
export function resolveSupportedRuntimeMode(
  requestedMode: RuntimeMode,
  presentation: ProviderPresentation
): RuntimeMode {
  if (presentation.supportedRuntimeModes.includes(requestedMode)) {
    return requestedMode;
  }
  return "supervised";
}

export class ProviderRegistry {
  private readonly drivers = new Map<string, ProviderDriver>();
  private readonly instances = new Map<string, ProviderAdapterV2>();

  public registerDriver<TSettings extends BaseProviderInstanceSettings>(
    driver: ProviderDriver<TSettings>
  ): void {
    this.drivers.set(driver.driverKind, driver as unknown as ProviderDriver);
  }

  public getDriver(driverKind: string): ProviderDriver | undefined {
    return this.drivers.get(driverKind);
  }

  public registerInstance<TSettings extends BaseProviderInstanceSettings>(
    settings: TSettings
  ): ProviderAdapterV2<TSettings> {
    const driver = this.drivers.get(settings.driverKind);
    if (!driver) {
      throw new Error(`Provider driver '${settings.driverKind}' is not registered`);
    }
    const adapter = driver.createAdapter(settings) as ProviderAdapterV2<TSettings>;
    this.instances.set(settings.instanceId, adapter);
    return adapter;
  }

  public getInstance(instanceId: string): ProviderAdapterV2 | undefined {
    return this.instances.get(instanceId);
  }

  public removeInstance(instanceId: string): boolean {
    return this.instances.delete(instanceId);
  }

  public listInstances(): readonly ProviderAdapterV2[] {
    return [...this.instances.values()];
  }
}
