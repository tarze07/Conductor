export const PACKAGE_NAME = "@conductor/desktop" as const;

export * from "./protocol/ConductorProtocolSchemeHandler.js";
export * from "./runtime/DesktopShellRuntime.js";
export * from "./updater/DesktopAutoUpdater.js";
export * from "./ipc/DesktopIpcBridge.js";
export * from "./packaging/OfflineBundleBuilder.js";
