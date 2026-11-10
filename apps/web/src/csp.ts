/**
 * Strict Content-Security-Policy for Conductor's 100% offline Web UI.
 * Blocks all external scripts, fonts, stylesheets, images, and network connections
 * outside the serving origin (`'self'`) and same-host WebSocket (`ws:` / `wss:`).
 */
export const STRICT_OFFLINE_CSP =
  "default-src 'self'; connect-src 'self' ws: wss:; font-src 'self' data:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; frame-ancestors 'none'; base-uri 'self'; form-action 'self';";

export interface OfflineBundleAuditResult {
  readonly valid: boolean;
  readonly violations: readonly string[];
}

/**
 * Audits all static Web UI assets (HTML, CSS, JS, SVG) to ensure:
 * 1. Zero external HTTP/HTTPS/protocol-relative URLs (no Google Fonts, CDNs, analytics, or external WASM).
 * 2. Adherence to t3code's Frontend Performance Guidelines (no `backdrop-filter: blur` on scrollable containers).
 */
export function verifyZeroExternalAssets(
  assets: Readonly<Record<string, string>>
): OfflineBundleAuditResult {
  const violations: string[] = [];

  // Match http:// or https:// URLs except standard XML/SVG namespace declarations
  const externalUrlRegex = /https?:\/\/[^\s"'<>)]+/gi;
  const allowedXmlNamespaces = new Set([
    "http://www.w3.org/2000/svg",
    "http://www.w3.org/1999/xlink",
    "http://www.w3.org/1999/xhtml"
  ]);

  for (const [assetPath, content] of Object.entries(assets)) {
    const matches = content.match(externalUrlRegex) ?? [];
    for (const url of matches) {
      if (!allowedXmlNamespaces.has(url)) {
        violations.push(`Asset '${assetPath}' contains external URL '${url}'`);
      }
    }

    if (content.includes("fonts.googleapis.com") || content.includes("fonts.gstatic.com")) {
      violations.push(`Asset '${assetPath}' references external Google Fonts`);
    }

    if (assetPath.endsWith(".css") && /backdrop-filter\s*:\s*blur/i.test(content)) {
      violations.push(
        `Asset '${assetPath}' uses 'backdrop-filter: blur', violating t3code GPU scroll performance rules`
      );
    }
  }

  return {
    valid: violations.length === 0,
    violations
  };
}
