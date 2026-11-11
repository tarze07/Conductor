import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OFFLINE_ENFORCED_ENV_VARS } from "@conductor/network-guard";
import { buildOfflineWebAssets, verifyZeroExternalAssets } from "@conductor/web";

export interface OfflineBundleFileEntry {
  readonly relativePath: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface OfflineBundleManifest {
  readonly productName: "Conductor";
  readonly version: string;
  readonly targetPlatform: string;
  readonly targetArch: string;
  readonly zeroExternalDependencies: true;
  readonly supportedFormats: readonly ("tar.gz" | "deb" | "rpm" | "AppImage" | "msi" | "docker")[];
  readonly enforcedEnvVars: Readonly<Record<string, string>>;
  readonly internalUpdateRegistryUrl?: string;
  readonly files: readonly OfflineBundleFileEntry[];
}

export interface BuildOfflineBundleOptions {
  readonly outputDir: string;
  readonly version?: string;
  readonly targetPlatform?: string;
  readonly targetArch?: string;
  readonly internalUpdateRegistryUrl?: string;
}

export interface VerifyOfflineBundleResult {
  readonly valid: boolean;
  readonly checkedFilesCount: number;
  readonly errors: readonly string[];
}

function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Generates self-contained Air-Gapped installation bundles (`tar.gz` layout, `.deb`, `.rpm`,
 * `.AppImage`, `.msi`, and `systemd` unit) that require zero internet connectivity during installation
 * or execution.
 */
export function buildOfflineBundle(options: BuildOfflineBundleOptions): OfflineBundleManifest {
  const version = options.version ?? "0.1.0";
  const targetPlatform = options.targetPlatform ?? process.platform;
  const targetArch = options.targetArch ?? process.arch;
  const outDir = options.outputDir;

  mkdirSync(outDir, { recursive: true });

  const fileContents = new Map<string, string>();

  // 1. 100% Offline Web UI Assets
  const webAssets = buildOfflineWebAssets({ defaultEnvironmentId: "env_airgap_default" });
  const rawWebAssets: Record<string, string> = {};
  for (const [route, entry] of Object.entries(webAssets)) {
    rawWebAssets[route] = entry.body;
    const rel =
      route === "/"
        ? "web-ui/root-index.html"
        : `web-ui/${route.replace(/^\//, "")}`;
    fileContents.set(rel, entry.body);
  }

  const webAudit = verifyZeroExternalAssets(rawWebAssets);
  if (!webAudit.valid) {
    throw new Error(
      `[ERR_OFFLINE_BUNDLE_WEB_AUDIT] Web assets failed offline check: ${webAudit.violations.join(
        "; "
      )}`
    );
  }

  // 2. Self-contained offline installer script (install-airgap.sh)
  const installScript = `#!/usr/bin/env bash
set -euo pipefail

# Conductor Air-Gapped Offline Installer (v${version})
# Requires ZERO internet connectivity. Verifies SHA256SUMS before copying files.

BUNDLE_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
PREFIX="\${CONDUCTOR_INSTALL_PREFIX:-/opt/conductor}"

echo "[Conductor Air-Gap] Weryfikacja sum kontrolnych SHA-256..."
(cd "\${BUNDLE_DIR}" && sha256sum -c SHA256SUMS)

echo "[Conductor Air-Gap] Instalacja w \${PREFIX} (tryb 100% offline)..."
mkdir -p "\${PREFIX}/web-ui" "\${PREFIX}/systemd"
cp -r "\${BUNDLE_DIR}/web-ui/"* "\${PREFIX}/web-ui/"
cp "\${BUNDLE_DIR}/offline-bundle-manifest.json" "\${PREFIX}/"
cp "\${BUNDLE_DIR}/systemd/conductor-server.service" "\${PREFIX}/systemd/"

echo "[Conductor Air-Gap] Instalacja zakończona pomyślnie."
`;
  fileContents.set("install-airgap.sh", installScript);

  // 3. Hardened systemd unit
  const systemdUnit = `[Unit]
Description=Conductor Intranet/Air-Gapped AI Coding Daemon
After=network.target

[Service]
Type=simple
User=conductor
Group=conductor
WorkingDirectory=/opt/conductor
Environment="CONDUCTOR_OFFLINE_MODE=1"
Environment="HF_HUB_OFFLINE=1"
Environment="TRANSFORMERS_OFFLINE=1"
Environment="CONDUCTOR_ALLOW_PUBLIC_EGRESS=0"
ExecStart=/usr/bin/env node /opt/conductor/bin/conductor-server.js
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=true

[Install]
WantedBy=multi-user.target
`;
  fileContents.set("systemd/conductor-server.service", systemdUnit);

  // 4. Debian (.deb) package control descriptor
  const debControl = `Package: conductor-intranet
Version: ${version}
Section: devel
Priority: optional
Architecture: ${targetArch === "x64" ? "amd64" : targetArch}
Maintainer: Conductor Enterprise Security Team <security@intranet.local>
Description: Conductor Air-Gapped AI Coding Control Surface (100% Offline Bundle)
 Self-contained intranet agent harness with SQLite Event Sourcing,
 Git hidden-ref checkpointing, and NetworkGuard RFC 1918 enforcement.
`;
  fileContents.set("packages/deb/DEBIAN/control", debControl);

  // 5. RPM (.rpm) spec descriptor
  const rpmSpec = `Name:           conductor-intranet
Version:        ${version}
Release:        1%{?dist}
Summary:        Conductor Air-Gapped AI Coding Control Surface
License:        Proprietary-Intranet
BuildArch:      ${targetArch === "x64" ? "x86_64" : targetArch}
AutoReqProv:    no

%description
Self-contained offline installation package for Conductor in isolated enterprise networks.

%files
/opt/conductor
`;
  fileContents.set("packages/rpm/conductor.spec", rpmSpec);

  // 6. Linux AppImage descriptor
  const appRun = `#!/usr/bin/env bash
set -euo pipefail
HERE="$(dirname "$(readlink -f "\${0}")")"
export CONDUCTOR_OFFLINE_MODE=1
export HF_HUB_OFFLINE=1
export CONDUCTOR_ALLOW_PUBLIC_EGRESS=0
exec "\${HERE}/usr/bin/conductor-desktop" "$@"
`;
  const desktopEntry = `[Desktop Entry]
Name=Conductor Studio (Air-Gapped)
Exec=AppRun
Icon=conductor
Type=Application
Categories=Development;IDE;
Comment=Intranet AI Agent Control Surface (Zero Internet)
`;
  fileContents.set("packages/appimage/AppRun", appRun);
  fileContents.set("packages/appimage/conductor.desktop", desktopEntry);

  // 7. Windows Enterprise MSI (WiX) descriptor
  const wxsContent = `<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="*" Name="Conductor Studio Air-Gapped" Language="1045" Version="${version}.0" Manufacturer="Conductor Intranet" UpgradeCode="2ef68f66-26c3-40c6-a07d-4e4a831e3a74">
    <Package InstallerVersion="500" Compressed="yes" InstallScope="perMachine" Description="Conductor 100% Offline Bundle" />
    <MediaTemplate EmbedCab="yes" />
    <Property Id="CONDUCTOR_OFFLINE_MODE" Value="1" />
  </Product>
</Wix>
`;
  fileContents.set("packages/msi/conductor.wxs", wxsContent);

  // Write all files and compute SHA-256 entries
  const entries: OfflineBundleFileEntry[] = [];
  const sha256SumsLines: string[] = [];

  for (const [relativePath, content] of fileContents.entries()) {
    const absPath = join(outDir, relativePath);
    mkdirSync(dirname(absPath), { recursive: true });
    const buf = Buffer.from(content, "utf8");
    writeFileSync(absPath, buf);
    const digest = sha256Hex(buf);
    entries.push({
      relativePath,
      sha256: digest,
      sizeBytes: buf.byteLength
    });
    sha256SumsLines.push(`${digest}  ${relativePath}`);
  }

  const manifest: OfflineBundleManifest = {
    productName: "Conductor",
    version,
    targetPlatform,
    targetArch,
    zeroExternalDependencies: true,
    supportedFormats: ["tar.gz", "deb", "rpm", "AppImage", "msi", "docker"],
    enforcedEnvVars: { ...OFFLINE_ENFORCED_ENV_VARS },
    internalUpdateRegistryUrl: options.internalUpdateRegistryUrl,
    files: entries
  };

  writeFileSync(
    join(outDir, "offline-bundle-manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8"
  );
  writeFileSync(join(outDir, "SHA256SUMS"), `${sha256SumsLines.join("\n")}\n`, "utf8");

  return manifest;
}

/**
 * Verifies the cryptographic and offline integrity of a generated air-gapped bundle directory.
 */
export function verifyOfflineBundleDirectory(bundleDir: string): VerifyOfflineBundleResult {
  const errors: string[] = [];
  const manifestPath = join(bundleDir, "offline-bundle-manifest.json");
  const sha256SumsPath = join(bundleDir, "SHA256SUMS");

  if (!existsSync(manifestPath)) {
    return {
      valid: false,
      checkedFilesCount: 0,
      errors: ["Missing offline-bundle-manifest.json"]
    };
  }
  if (!existsSync(sha256SumsPath)) {
    return {
      valid: false,
      checkedFilesCount: 0,
      errors: ["Missing SHA256SUMS"]
    };
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as OfflineBundleManifest;
  if (manifest.zeroExternalDependencies !== true) {
    errors.push("Manifest does not enforce zeroExternalDependencies: true");
  }
  if (manifest.enforcedEnvVars.CONDUCTOR_OFFLINE_MODE !== "1") {
    errors.push("Manifest missing CONDUCTOR_OFFLINE_MODE=1");
  }

  const webAssetsToAudit: Record<string, string> = {};
  let checkedCount = 0;

  for (const entry of manifest.files) {
    const absPath = join(bundleDir, entry.relativePath);
    if (!existsSync(absPath)) {
      errors.push(`Missing bundled file: ${entry.relativePath}`);
      continue;
    }

    const buf = readFileSync(absPath);
    if (buf.byteLength !== entry.sizeBytes) {
      errors.push(
        `Size mismatch for ${entry.relativePath}: expected ${entry.sizeBytes}, got ${buf.byteLength}`
      );
    }

    const actualHash = sha256Hex(buf);
    if (actualHash !== entry.sha256) {
      errors.push(
        `SHA-256 mismatch for ${entry.relativePath}: expected ${entry.sha256}, got ${actualHash}`
      );
    }

    if (entry.relativePath.startsWith("web-ui/")) {
      webAssetsToAudit[entry.relativePath] = buf.toString("utf8");
    }

    checkedCount += 1;
  }

  const audit = verifyZeroExternalAssets(webAssetsToAudit);
  if (!audit.valid) {
    errors.push(...audit.violations);
  }

  return {
    valid: errors.length === 0,
    checkedFilesCount: checkedCount,
    errors
  };
}
