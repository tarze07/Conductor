import { createHash, sign, verify } from "node:crypto";
import { NetworkPolicyEvaluator } from "@conductor/network-guard";

export interface IntranetReleaseManifest {
  readonly version: string;
  readonly publishedAt: string;
  readonly artifactPath: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly releaseNotes?: string;
  readonly signatureBase64: string;
}

export interface DesktopUpdateCheckResult {
  readonly mode: "disabled" | "intranet-registry";
  readonly currentVersion: string;
  readonly updateAvailable: boolean;
  readonly latestVersion?: string;
  readonly manifest?: IntranetReleaseManifest;
}

export interface VerifiedUpdateArtifact {
  readonly version: string;
  readonly sha256: string;
  readonly payload: Buffer;
}

export interface DesktopAutoUpdaterOptions {
  readonly currentVersion: string;
  readonly updateServerBaseUrl?: string;
  readonly releasePublicKeyPem?: string;
  readonly networkEvaluator?: NetworkPolicyEvaluator;
  readonly fetchImpl?: typeof fetch;
}

export function canonicalizeReleasePayload(
  manifest: Pick<
    IntranetReleaseManifest,
    "version" | "publishedAt" | "artifactPath" | "sha256" | "sizeBytes"
  >
): string {
  return JSON.stringify({
    version: manifest.version,
    publishedAt: manifest.publishedAt,
    artifactPath: manifest.artifactPath,
    sha256: manifest.sha256.toLowerCase(),
    sizeBytes: manifest.sizeBytes
  });
}

export function signIntranetReleaseManifest(params: {
  readonly version: string;
  readonly publishedAt: string;
  readonly artifactPath: string;
  readonly artifactBytes: Buffer;
  readonly releaseNotes?: string;
  readonly privateKeyPem: string;
}): IntranetReleaseManifest {
  const sha256 = createHash("sha256").update(params.artifactBytes).digest("hex");
  const sizeBytes = params.artifactBytes.byteLength;
  const canonical = canonicalizeReleasePayload({
    version: params.version,
    publishedAt: params.publishedAt,
    artifactPath: params.artifactPath,
    sha256,
    sizeBytes
  });

  const signature = sign(null, Buffer.from(canonical, "utf8"), params.privateKeyPem);

  return {
    version: params.version,
    publishedAt: params.publishedAt,
    artifactPath: params.artifactPath,
    sha256,
    sizeBytes,
    releaseNotes: params.releaseNotes,
    signatureBase64: signature.toString("base64")
  };
}

function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/**
 * Air-gapped / intranet-only Desktop Auto-Updater.
 *
 * Security Invariants:
 * 1. Never phones home to GitHub Releases or public CDNs. If `updateServerBaseUrl` is omitted,
 *    auto-update is strictly disabled.
 * 2. Every update manifest URL and artifact download URL is verified through `@conductor/network-guard`
 *    (`NetworkPolicyEvaluator`) to enforce RFC 1918 / internal allowlist rules.
 * 3. Every `latest-intranet.json` manifest must carry a valid Ed25519 signature from the corporate
 *    release key (`releasePublicKeyPem`), and downloaded bytes are verified against `manifest.sha256`.
 */
export class DesktopAutoUpdater {
  private readonly currentVersion: string;
  private readonly updateServerBaseUrl?: string;
  private readonly releasePublicKeyPem?: string;
  private readonly networkEvaluator: NetworkPolicyEvaluator;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DesktopAutoUpdaterOptions) {
    this.currentVersion = options.currentVersion;
    this.updateServerBaseUrl = options.updateServerBaseUrl?.replace(/\/$/, "");
    this.releasePublicKeyPem = options.releasePublicKeyPem;
    this.networkEvaluator = options.networkEvaluator ?? new NetworkPolicyEvaluator();
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async checkForUpdates(): Promise<DesktopUpdateCheckResult> {
    if (!this.updateServerBaseUrl) {
      return {
        mode: "disabled",
        currentVersion: this.currentVersion,
        updateAvailable: false
      };
    }

    const manifestUrl = `${this.updateServerBaseUrl}/latest-intranet.json`;
    await this.networkEvaluator.verifyUrl(manifestUrl);

    const response = await this.fetchImpl(manifestUrl, {
      method: "GET",
      headers: { accept: "application/json" }
    });

    if (!response.ok) {
      throw new Error(
        `[ERR_UPDATER_MANIFEST_HTTP] Intranet artifact server returned HTTP ${response.status}`
      );
    }

    const manifest = (await response.json()) as IntranetReleaseManifest;
    this.verifyManifestSignature(manifest);

    const updateAvailable = compareSemver(manifest.version, this.currentVersion) > 0;
    return {
      mode: "intranet-registry",
      currentVersion: this.currentVersion,
      updateAvailable,
      latestVersion: manifest.version,
      manifest
    };
  }

  public async downloadAndVerifyUpdate(
    manifest: IntranetReleaseManifest
  ): Promise<VerifiedUpdateArtifact> {
    if (!this.updateServerBaseUrl) {
      throw new Error("[ERR_UPDATER_DISABLED] No intranet update server configured");
    }

    this.verifyManifestSignature(manifest);

    const cleanArtifactPath = manifest.artifactPath.replace(/^\//, "");
    const artifactUrl = `${this.updateServerBaseUrl}/${cleanArtifactPath}`;
    await this.networkEvaluator.verifyUrl(artifactUrl);

    const response = await this.fetchImpl(artifactUrl, {
      method: "GET"
    });

    if (!response.ok) {
      throw new Error(
        `[ERR_UPDATER_DOWNLOAD_HTTP] Artifact download failed with HTTP ${response.status}`
      );
    }

    const arrayBuf = await response.arrayBuffer();
    const payload = Buffer.from(arrayBuf);

    if (payload.byteLength !== manifest.sizeBytes) {
      throw new Error(
        `[ERR_UPDATER_SIZE_MISMATCH] Expected ${manifest.sizeBytes} bytes, received ${payload.byteLength}`
      );
    }

    const actualSha256 = createHash("sha256").update(payload).digest("hex");
    if (actualSha256 !== manifest.sha256.toLowerCase()) {
      throw new Error(
        `[ERR_UPDATER_SHA256_MISMATCH] Expected SHA-256 ${manifest.sha256}, computed ${actualSha256}`
      );
    }

    return {
      version: manifest.version,
      sha256: actualSha256,
      payload
    };
  }

  private verifyManifestSignature(manifest: IntranetReleaseManifest): void {
    if (!this.releasePublicKeyPem) {
      throw new Error(
        "[ERR_UPDATER_MISSING_PUBLIC_KEY] Corporate Ed25519 releasePublicKeyPem is required to verify updates"
      );
    }

    const canonical = canonicalizeReleasePayload(manifest);
    const sigBuffer = Buffer.from(manifest.signatureBase64, "base64");
    const isValid = verify(
      null,
      Buffer.from(canonical, "utf8"),
      this.releasePublicKeyPem,
      sigBuffer
    );

    if (!isValid) {
      throw new Error(
        `[ERR_UPDATER_SIGNATURE_INVALID] Release manifest for v${manifest.version} failed Ed25519 signature verification`
      );
    }
  }
}
