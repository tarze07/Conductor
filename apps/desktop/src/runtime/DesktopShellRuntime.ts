import { startConductorDaemon, type StartedConductorDaemon } from "@conductor/cli";
import {
  MultiEnvironmentRegistry,
  type EnvironmentClient,
  type ScopedEnvironmentRegistration
} from "@conductor/client-runtime";
import type { EnvironmentRoute, RpcScope } from "@conductor/contracts";
import { WebUiStore } from "@conductor/web";
import {
  ConductorProtocolSchemeHandler,
  type ConductorProtocolResponse
} from "../protocol/ConductorProtocolSchemeHandler.js";
import {
  DesktopAutoUpdater,
  type DesktopAutoUpdaterOptions,
  type DesktopUpdateCheckResult
} from "../updater/DesktopAutoUpdater.js";

export interface DesktopShellStatus {
  readonly running: boolean;
  readonly localEnvironmentEnabled: boolean;
  readonly localEnvironmentId?: string;
  readonly localWebUiUrl?: string;
  readonly activeEnvironmentId: string;
  readonly registeredEnvironments: readonly ScopedEnvironmentRegistration[];
  readonly protocolScheme: "conductor://app";
}

export interface DesktopShellRuntimeOptions {
  readonly localEnvironmentEnabled?: boolean;
  readonly dataDir?: string;
  readonly dbPath?: string;
  readonly updaterOptions?: DesktopAutoUpdaterOptions;
}

/**
 * Core Electron/Tauri Desktop Application Coordinator (`@conductor/desktop`).
 *
 * Implements t3code's Desktop Environment Architecture:
 * - Bundles the 100% offline Web UI under `conductor://app/*` (`ConductorProtocolSchemeHandler`).
 * - Supports the `localEnvironmentEnabled` toggle:
 *   - When `true` (default): runs an embedded local Conductor server (`127.0.0.1`), pairs automatically
 *     via DPoP + bootstrap token, and exposes it as the primary local environment.
 *   - When `false`: shuts down the local server process so the Desktop shell operates purely as a
 *     zero-footprint client for remote intranet/LAN/SSH environments (`MultiEnvironmentRegistry`).
 */
export class DesktopShellRuntime {
  private running = false;
  private localEnvironmentEnabled: boolean;
  private readonly dataDir?: string;
  private readonly dbPath?: string;
  private localDaemon?: StartedConductorDaemon;
  private readonly registry = new MultiEnvironmentRegistry();
  private readonly webUiStore = new WebUiStore();
  private protocolHandler: ConductorProtocolSchemeHandler;
  private readonly updater: DesktopAutoUpdater;

  constructor(options: DesktopShellRuntimeOptions = {}) {
    this.localEnvironmentEnabled = options.localEnvironmentEnabled ?? true;
    this.dataDir = options.dataDir;
    this.dbPath = options.dbPath;
    this.protocolHandler = new ConductorProtocolSchemeHandler({
      defaultEnvironmentId: "env_desktop_boot"
    });
    this.updater = new DesktopAutoUpdater(
      options.updaterOptions ?? {
        currentVersion: "0.1.0"
      }
    );
  }

  public async start(): Promise<DesktopShellStatus> {
    if (this.running) {
      return this.getStatus();
    }
    this.running = true;

    if (this.localEnvironmentEnabled) {
      await this.startEmbeddedLocalEnvironment();
    }

    return this.getStatus();
  }

  public async setLocalEnvironmentEnabled(enabled: boolean): Promise<DesktopShellStatus> {
    this.localEnvironmentEnabled = enabled;

    if (!this.running) {
      return this.getStatus();
    }

    if (enabled && !this.localDaemon) {
      await this.startEmbeddedLocalEnvironment();
    } else if (!enabled && this.localDaemon) {
      await this.stopEmbeddedLocalEnvironment();
    }

    return this.getStatus();
  }

  public async connectRemoteEnvironment(params: {
    readonly environmentId: string;
    readonly label: string;
    readonly routes: readonly EnvironmentRoute[];
    readonly pairingCode: string;
    readonly scopes?: readonly RpcScope[];
  }): Promise<EnvironmentClient> {
    const client = this.registry.registerEnvironment({
      environmentId: params.environmentId,
      label: params.label,
      routes: params.routes
    });

    await client.connectWithPairingCode({
      pairingCode: params.pairingCode,
      requestedScopes: params.scopes,
      subject: "desktop-remote-client"
    });

    if (!this.localDaemon) {
      this.webUiStore.setActiveEnvironmentId(params.environmentId);
    }

    return client;
  }

  public async disconnectRemoteEnvironment(environmentId: string): Promise<void> {
    if (this.localDaemon && this.localDaemon.environmentId === environmentId) {
      throw new Error(
        "Use setLocalEnvironmentEnabled(false) to stop the primary local environment"
      );
    }
    await this.registry.removeEnvironment(environmentId);
  }

  public getEnvironmentClient(environmentId: string): EnvironmentClient | undefined {
    return this.registry.getClient(environmentId);
  }

  public getLocalDaemon(): StartedConductorDaemon | undefined {
    return this.localDaemon;
  }

  public getMultiEnvironmentRegistry(): MultiEnvironmentRegistry {
    return this.registry;
  }

  public getWebUiStore(): WebUiStore {
    return this.webUiStore;
  }

  public resolveProtocolRequest(url: string): ConductorProtocolResponse {
    return this.protocolHandler.resolve(url);
  }

  public async checkForUpdates(): Promise<DesktopUpdateCheckResult> {
    return this.updater.checkForUpdates();
  }

  public getUpdater(): DesktopAutoUpdater {
    return this.updater;
  }

  public getStatus(): DesktopShellStatus {
    return {
      running: this.running,
      localEnvironmentEnabled: this.localEnvironmentEnabled,
      localEnvironmentId: this.localDaemon?.environmentId,
      localWebUiUrl: this.localDaemon?.webUiUrl,
      activeEnvironmentId: this.webUiStore.getActiveEnvironmentId(),
      registeredEnvironments: this.registry.listRegistrations(),
      protocolScheme: "conductor://app"
    };
  }

  public async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    await this.registry.closeAll();
    if (this.localDaemon) {
      await this.localDaemon.close();
      this.localDaemon = undefined;
    }
    this.running = false;
  }

  private async startEmbeddedLocalEnvironment(): Promise<void> {
    const daemon = await startConductorDaemon({
      dataDir: this.dataDir,
      dbPath: this.dbPath,
      host: "127.0.0.1",
      port: 0,
      label: "desktop-embedded-local"
    });

    this.localDaemon = daemon;
    this.protocolHandler = new ConductorProtocolSchemeHandler({
      defaultEnvironmentId: daemon.environmentId
    });

    const httpBaseUrl = `http://${daemon.host}:${daemon.port}`;
    const wsBaseUrl = `ws://${daemon.host}:${daemon.port}`;

    const client = this.registry.registerEnvironment({
      environmentId: daemon.environmentId,
      label: "Lokalne środowisko Desktop (127.0.0.1)",
      routes: [
        {
          kind: "loopback",
          httpBaseUrl,
          wsBaseUrl
        }
      ]
    });

    await client.connectWithPairingCode({
      pairingCode: daemon.bootstrapPairingCode,
      subject: "desktop-local-owner"
    });

    this.webUiStore.setActiveEnvironmentId(daemon.environmentId);
  }

  private async stopEmbeddedLocalEnvironment(): Promise<void> {
    if (!this.localDaemon) {
      return;
    }
    const localEnvId = this.localDaemon.environmentId;
    await this.registry.removeEnvironment(localEnvId);
    await this.localDaemon.close();
    this.localDaemon = undefined;

    const remaining = this.registry.listRegistrations();
    if (remaining.length > 0) {
      this.webUiStore.setActiveEnvironmentId(remaining[0]!.environmentId);
    } else {
      this.webUiStore.setActiveEnvironmentId("env_none");
    }
  }
}
