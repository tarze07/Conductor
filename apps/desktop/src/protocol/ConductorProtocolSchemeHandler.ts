import { createHash } from "node:crypto";
import {
  STRICT_OFFLINE_CSP,
  buildOfflineWebAssets,
  verifyZeroExternalAssets,
  type OfflineWebAssetEntry
} from "@conductor/web";

export interface ConductorProtocolResponse {
  readonly statusCode: number;
  readonly contentType: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly sha256: string;
}

export interface ConductorProtocolSchemeOptions {
  readonly defaultEnvironmentId?: string;
  readonly customAssets?: Readonly<Record<string, OfflineWebAssetEntry>>;
}

function computeSha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Enforces that top-level window navigation in the Electron/Tauri shell is restricted
 * strictly to the internal `conductor://app` origin (zero external browsing).
 */
export function isAllowedDesktopNavigationUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "conductor:" && parsed.hostname === "app";
  } catch {
    return false;
  }
}

/**
 * Custom protocol handler (`conductor://app/...`) for the Electron/Tauri desktop shell.
 *
 * Responsibilities:
 * 1. Serves the 100% offline Web UI bundle (`@conductor/web`) from memory/ASAR without network access.
 * 2. Audits all bundled assets at initialization (`verifyZeroExternalAssets`) and precomputes SHA-256 hashes.
 * 3. Attaches `STRICT_OFFLINE_CSP` and security headers to every response.
 * 4. Blocks path traversal (`..`) and non-`conductor://app` hosts.
 */
export class ConductorProtocolSchemeHandler {
  private readonly assets = new Map<
    string,
    {
      readonly contentType: string;
      readonly body: string;
      readonly expectedSha256: string;
    }
  >();

  constructor(options: ConductorProtocolSchemeOptions = {}) {
    const baseAssets =
      options.customAssets ??
      buildOfflineWebAssets({
        defaultEnvironmentId: options.defaultEnvironmentId
      });

    const rawBodyMap: Record<string, string> = {};
    for (const [routePath, entry] of Object.entries(baseAssets)) {
      rawBodyMap[routePath] = entry.body;
    }

    const audit = verifyZeroExternalAssets(rawBodyMap);
    if (!audit.valid) {
      throw new Error(
        `[ERR_DESKTOP_BUNDLE_AUDIT_FAILED] Offline Web UI bundle failed zero-external-asset audit: ${audit.violations.join(
          "; "
        )}`
      );
    }

    for (const [routePath, entry] of Object.entries(baseAssets)) {
      this.assets.set(routePath, {
        contentType: entry.contentType,
        body: entry.body,
        expectedSha256: computeSha256Hex(entry.body)
      });
    }
  }

  public getAssetManifest(): Readonly<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [routePath, asset] of this.assets.entries()) {
      out[routePath] = asset.expectedSha256;
    }
    return out;
  }

  public resolve(requestUrl: string): ConductorProtocolResponse {
    const securityHeaders: Readonly<Record<string, string>> = {
      "Content-Security-Policy": STRICT_OFFLINE_CSP,
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer"
    };

    if (!isAllowedDesktopNavigationUrl(requestUrl)) {
      const forbiddenBody = "Forbidden: Only conductor://app/* URLs are permitted";
      return {
        statusCode: 403,
        contentType: "text/plain; charset=utf-8",
        headers: securityHeaders,
        body: forbiddenBody,
        sha256: computeSha256Hex(forbiddenBody)
      };
    }

    const decodedRawUrl = decodeURIComponent(requestUrl);
    if (requestUrl.includes("..") || decodedRawUrl.includes("..")) {
      const traversalBody = "Forbidden: Path traversal rejected";
      return {
        statusCode: 403,
        contentType: "text/plain; charset=utf-8",
        headers: securityHeaders,
        body: traversalBody,
        sha256: computeSha256Hex(traversalBody)
      };
    }

    const parsed = new URL(requestUrl);
    const rawPathname = decodeURIComponent(parsed.pathname || "/");

    const normalizedPath = rawPathname === "" ? "/" : rawPathname;
    const asset = this.assets.get(normalizedPath);

    if (!asset) {
      const notFoundBody = `Not Found: ${normalizedPath}`;
      return {
        statusCode: 404,
        contentType: "text/plain; charset=utf-8",
        headers: securityHeaders,
        body: notFoundBody,
        sha256: computeSha256Hex(notFoundBody)
      };
    }

    const actualSha256 = computeSha256Hex(asset.body);
    if (actualSha256 !== asset.expectedSha256) {
      throw new Error(
        `[ERR_ASSET_INTEGRITY_VIOLATION] SHA-256 mismatch for '${normalizedPath}'`
      );
    }

    return {
      statusCode: 200,
      contentType: asset.contentType,
      headers: securityHeaders,
      body: asset.body,
      sha256: actualSha256
    };
  }
}
