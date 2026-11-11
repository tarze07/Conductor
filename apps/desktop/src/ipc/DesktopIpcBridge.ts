import type { EnvironmentRoute, RpcScope } from "@conductor/contracts";
import type { ConductorProtocolResponse } from "../protocol/ConductorProtocolSchemeHandler.js";
import type { DesktopShellRuntime, DesktopShellStatus } from "../runtime/DesktopShellRuntime.js";
import type { DesktopUpdateCheckResult } from "../updater/DesktopAutoUpdater.js";

export type DesktopIpcChannel =
  | "desktop:getStatus"
  | "desktop:setLocalEnvironmentEnabled"
  | "desktop:connectRemoteEnvironment"
  | "desktop:disconnectRemoteEnvironment"
  | "desktop:checkForUpdates"
  | "desktop:resolveProtocolAsset";

export interface ConnectRemoteEnvironmentPayload {
  readonly environmentId: string;
  readonly label: string;
  readonly routes: readonly EnvironmentRoute[];
  readonly pairingCode: string;
  readonly scopes?: readonly RpcScope[];
}

/**
 * Strongly-typed IPC bridge between the Electron/Tauri main process (`DesktopShellRuntime`)
 * and the isolated `conductor://app` renderer context (`contextBridge.exposeInMainWorld`).
 */
export class DesktopIpcBridge {
  private readonly runtime: DesktopShellRuntime;

  constructor(runtime: DesktopShellRuntime) {
    this.runtime = runtime;
  }

  public async invoke(
    channel: "desktop:getStatus"
  ): Promise<DesktopShellStatus>;
  public async invoke(
    channel: "desktop:setLocalEnvironmentEnabled",
    payload: { readonly enabled: boolean }
  ): Promise<DesktopShellStatus>;
  public async invoke(
    channel: "desktop:connectRemoteEnvironment",
    payload: ConnectRemoteEnvironmentPayload
  ): Promise<{ readonly environmentId: string; readonly connected: boolean }>;
  public async invoke(
    channel: "desktop:disconnectRemoteEnvironment",
    payload: { readonly environmentId: string }
  ): Promise<{ readonly disconnected: boolean }>;
  public async invoke(
    channel: "desktop:checkForUpdates"
  ): Promise<DesktopUpdateCheckResult>;
  public async invoke(
    channel: "desktop:resolveProtocolAsset",
    payload: { readonly url: string }
  ): Promise<ConductorProtocolResponse>;
  public async invoke(
    channel: DesktopIpcChannel,
    payload?: unknown
  ): Promise<unknown> {
    switch (channel) {
      case "desktop:getStatus":
        return this.runtime.getStatus();

      case "desktop:setLocalEnvironmentEnabled": {
        const p = payload as { readonly enabled: boolean };
        return this.runtime.setLocalEnvironmentEnabled(Boolean(p.enabled));
      }

      case "desktop:connectRemoteEnvironment": {
        const p = payload as ConnectRemoteEnvironmentPayload;
        await this.runtime.connectRemoteEnvironment(p);
        return {
          environmentId: p.environmentId,
          connected: true
        };
      }

      case "desktop:disconnectRemoteEnvironment": {
        const p = payload as { readonly environmentId: string };
        await this.runtime.disconnectRemoteEnvironment(p.environmentId);
        return { disconnected: true };
      }

      case "desktop:checkForUpdates":
        return this.runtime.checkForUpdates();

      case "desktop:resolveProtocolAsset": {
        const p = payload as { readonly url: string };
        return this.runtime.resolveProtocolRequest(p.url);
      }

      default:
        throw new Error(`Unsupported Desktop IPC channel: ${String(channel)}`);
    }
  }
}
