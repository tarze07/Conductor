import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { TamperEvidentAuditChain, type AuditRecord } from "@conductor/shared";
import {
  DEFAULT_INTRANET_CIDRS,
  TAILNET_CGNAT_CIDR,
  isIpInCidrs,
  normalizeIpAddress,
  parseCidr,
  type ParsedCidr
} from "./cidr.js";

export const ERR_EGRESS_BLOCKED_BY_POLICY = "ERR_EGRESS_BLOCKED_BY_POLICY" as const;

export class EgressBlockedError extends Error {
  public readonly code = ERR_EGRESS_BLOCKED_BY_POLICY;
  public readonly targetHost: string;
  public readonly targetUrl?: string;
  public readonly resolvedIps: readonly string[];
  public readonly reason: string;

  constructor(params: {
    readonly targetHost: string;
    readonly targetUrl?: string;
    readonly resolvedIps?: readonly string[];
    readonly reason: string;
  }) {
    const detail = params.targetUrl ?? params.targetHost;
    super(
      `[${ERR_EGRESS_BLOCKED_BY_POLICY}] Outbound connection to '${detail}' blocked by Zero-Internet policy: ${params.reason}`
    );
    this.name = "EgressBlockedError";
    this.targetHost = params.targetHost;
    this.targetUrl = params.targetUrl;
    this.resolvedIps = params.resolvedIps ?? [];
    this.reason = params.reason;
  }
}

export interface NetworkAuditPayload {
  readonly decision: "allow" | "block";
  readonly targetHost: string;
  readonly targetUrl?: string;
  readonly resolvedIps: readonly string[];
  readonly reason: string;
}

export type HostResolver = (hostname: string) => Promise<readonly string[]>;

export interface NetworkGuardPolicyConfig {
  /**
   * Additional corporate CIDR ranges allowed beyond RFC 1918 / loopback / RFC 4193.
   */
  readonly extraAllowedCidrs?: readonly string[];
  /**
   * Whether to allow CGNAT / Headscale / Tailscale range `100.64.0.0/10`.
   * Defaults to false unless explicitly enabled for self-hosted Headscale/Tailnet.
   */
  readonly allowTailnetCgnat?: boolean;
  /**
   * Optional hostname patterns (e.g. `["localhost", "*.corp.internal", "gitlab.firma.local"]`).
   * If non-empty and `requireAllowedHostnamePattern` is true, hostnames (non-IP literals)
   * must also match one of these patterns in addition to resolving to an intranet IP.
   */
  readonly allowedHostPatterns?: readonly string[];
  readonly requireAllowedHostnamePattern?: boolean;
  /**
   * Path to corporate Root CA PEM bundle for on-premise HTTPS/WSS endpoints.
   */
  readonly caBundlePath?: string;
  /**
   * Optional custom DNS resolver (useful for deterministic unit tests and offline hosts).
   */
  readonly hostResolver?: HostResolver;
  /**
   * Optional callback invoked on every egress check (both allowed and blocked).
   */
  readonly onAuditRecord?: (record: AuditRecord<NetworkAuditPayload>) => void;
}

export function matchesHostPattern(hostname: string, pattern: string): boolean {
  const cleanHost = hostname.trim().toLowerCase().replace(/\.$/, "");
  const cleanPattern = pattern.trim().toLowerCase().replace(/\.$/, "");
  if (cleanPattern === "*") {
    return true;
  }
  if (cleanPattern.startsWith("*.")) {
    const suffix = cleanPattern.slice(1); // ".corp.internal"
    return cleanHost.endsWith(suffix) && cleanHost.length > suffix.length;
  }
  return cleanHost === cleanPattern;
}

export const defaultHostResolver: HostResolver = async (hostname: string): Promise<readonly string[]> => {
  const normalized = normalizeIpAddress(hostname);
  if (isIP(normalized) !== 0) {
    return [normalized];
  }
  if (normalized.toLowerCase() === "localhost" || normalized.toLowerCase().endsWith(".localhost")) {
    return ["127.0.0.1", "::1"];
  }
  const records = await dnsLookup(normalized, { all: true, verbatim: true });
  return records.map((r) => normalizeIpAddress(r.address));
};

export class NetworkPolicyEvaluator {
  private readonly parsedCidrs: readonly ParsedCidr[];
  private readonly allowedHostPatterns: readonly string[];
  private readonly requireAllowedHostnamePattern: boolean;
  private readonly resolver: HostResolver;
  private readonly auditChain = new TamperEvidentAuditChain<NetworkAuditPayload>();
  private readonly onAuditRecord?: (record: AuditRecord<NetworkAuditPayload>) => void;
  public readonly caBundlePath?: string;

  constructor(config: NetworkGuardPolicyConfig = {}) {
    const cidrStrings = [
      ...DEFAULT_INTRANET_CIDRS,
      ...(config.allowTailnetCgnat ? [TAILNET_CGNAT_CIDR] : []),
      ...(config.extraAllowedCidrs ?? [])
    ];
    this.parsedCidrs = cidrStrings.map((c) => parseCidr(c));
    this.allowedHostPatterns = config.allowedHostPatterns ?? ["localhost", "*.localhost", "*.local", "*.internal"];
    this.requireAllowedHostnamePattern = config.requireAllowedHostnamePattern ?? false;
    this.resolver = config.hostResolver ?? defaultHostResolver;
    this.onAuditRecord = config.onAuditRecord;
    this.caBundlePath = config.caBundlePath;
  }

  public getAuditRecords(): readonly AuditRecord<NetworkAuditPayload>[] {
    return this.auditChain.getRecords();
  }

  public verifyAuditIntegrity(): boolean {
    return this.auditChain.verifyIntegrity();
  }

  public isIpAllowed(ip: string): boolean {
    return isIpInCidrs(ip, this.parsedCidrs);
  }

  public async verifyHost(
    rawHost: string,
    targetUrl?: string
  ): Promise<{ readonly resolvedIps: readonly string[] }> {
    const host = normalizeIpAddress(rawHost);
    if (!host) {
      throw this.recordAndBlock({
        targetHost: rawHost,
        targetUrl,
        resolvedIps: [],
        reason: "Empty target hostname"
      });
    }

    const ipVersion = isIP(host);
    if (ipVersion !== 0) {
      if (!this.isIpAllowed(host)) {
        throw this.recordAndBlock({
          targetHost: host,
          targetUrl,
          resolvedIps: [host],
          reason: `IP address ${host} is outside allowed intranet/loopback CIDR ranges`
        });
      }
      this.recordAllow({
        targetHost: host,
        targetUrl,
        resolvedIps: [host],
        reason: "Direct private/loopback IP literal allowed"
      });
      return { resolvedIps: [host] };
    }

    if (this.requireAllowedHostnamePattern) {
      const patternMatched = this.allowedHostPatterns.some((pattern) =>
        matchesHostPattern(host, pattern)
      );
      if (!patternMatched) {
        throw this.recordAndBlock({
          targetHost: host,
          targetUrl,
          resolvedIps: [],
          reason: `Hostname '${host}' does not match any allowed corporate domain pattern`
        });
      }
    }

    let resolvedIps: readonly string[];
    try {
      resolvedIps = await this.resolver(host);
    } catch (error) {
      throw this.recordAndBlock({
        targetHost: host,
        targetUrl,
        resolvedIps: [],
        reason: `DNS resolution failed or blocked for '${host}': ${
          error instanceof Error ? error.message : String(error)
        }`
      });
    }

    if (resolvedIps.length === 0) {
      throw this.recordAndBlock({
        targetHost: host,
        targetUrl,
        resolvedIps: [],
        reason: `Hostname '${host}' resolved to zero IP addresses`
      });
    }

    const disallowedIps = resolvedIps.filter((ip) => !this.isIpAllowed(ip));
    if (disallowedIps.length > 0) {
      throw this.recordAndBlock({
        targetHost: host,
        targetUrl,
        resolvedIps,
        reason: `Hostname '${host}' resolved to public/disallowed IP address(es): ${disallowedIps.join(", ")}`
      });
    }

    this.recordAllow({
      targetHost: host,
      targetUrl,
      resolvedIps,
      reason: `Hostname '${host}' resolved exclusively to allowed intranet IP(s)`
    });
    return { resolvedIps };
  }

  public async verifyUrl(input: string | URL): Promise<{ readonly url: URL; readonly resolvedIps: readonly string[] }> {
    const parsedUrl = typeof input === "string" ? new URL(input) : input;
    const protocol = parsedUrl.protocol.toLowerCase();

    if (protocol === "file:" || protocol === "data:" || protocol === "blob:" || protocol === "conductor:") {
      this.recordAllow({
        targetHost: "local-scheme",
        targetUrl: parsedUrl.toString(),
        resolvedIps: [],
        reason: `Local scheme '${protocol}' allowed`
      });
      return { url: parsedUrl, resolvedIps: [] };
    }

    if (protocol !== "http:" && protocol !== "https:" && protocol !== "ws:" && protocol !== "wss:") {
      throw this.recordAndBlock({
        targetHost: parsedUrl.hostname || protocol,
        targetUrl: parsedUrl.toString(),
        resolvedIps: [],
        reason: `Unsupported outbound protocol '${protocol}'`
      });
    }

    const { resolvedIps } = await this.verifyHost(parsedUrl.hostname, parsedUrl.toString());
    return { url: parsedUrl, resolvedIps };
  }

  private recordAllow(params: {
    readonly targetHost: string;
    readonly targetUrl?: string;
    readonly resolvedIps: readonly string[];
    readonly reason: string;
  }): void {
    const rec = this.auditChain.append("network-guard", "egress.allow", {
      decision: "allow",
      targetHost: params.targetHost,
      targetUrl: params.targetUrl,
      resolvedIps: params.resolvedIps,
      reason: params.reason
    });
    this.onAuditRecord?.(rec);
  }

  private recordAndBlock(params: {
    readonly targetHost: string;
    readonly targetUrl?: string;
    readonly resolvedIps: readonly string[];
    readonly reason: string;
  }): EgressBlockedError {
    const rec = this.auditChain.append("network-guard", "egress.block", {
      decision: "block",
      targetHost: params.targetHost,
      targetUrl: params.targetUrl,
      resolvedIps: params.resolvedIps,
      reason: params.reason
    });
    this.onAuditRecord?.(rec);
    return new EgressBlockedError(params);
  }
}
