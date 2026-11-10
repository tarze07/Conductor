import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_INTRANET_CIDRS,
  ERR_EGRESS_BLOCKED_BY_POLICY,
  EgressBlockedError,
  NetworkPolicyEvaluator,
  installNetworkGuard,
  isIpInCidrs,
  loadCorporateCaBundle,
  normalizeIpAddress,
  sanitizeSubprocessEnv
} from "./index.js";

describe("@conductor/network-guard CIDR and IP normalization", () => {
  it("allows RFC 1918 private IPs, loopback, and IPv6 ULA while rejecting public IPs", () => {
    expect(isIpInCidrs("127.0.0.1", DEFAULT_INTRANET_CIDRS)).toBe(true);
    expect(isIpInCidrs("10.42.0.15", DEFAULT_INTRANET_CIDRS)).toBe(true);
    expect(isIpInCidrs("172.16.0.1", DEFAULT_INTRANET_CIDRS)).toBe(true);
    expect(isIpInCidrs("172.31.255.254", DEFAULT_INTRANET_CIDRS)).toBe(true);
    expect(isIpInCidrs("192.168.1.100", DEFAULT_INTRANET_CIDRS)).toBe(true);
    expect(isIpInCidrs("::1", DEFAULT_INTRANET_CIDRS)).toBe(true);
    expect(isIpInCidrs("fd12:3456:789a::1", DEFAULT_INTRANET_CIDRS)).toBe(true);

    // Public IPs must be rejected
    expect(isIpInCidrs("8.8.8.8", DEFAULT_INTRANET_CIDRS)).toBe(false);
    expect(isIpInCidrs("1.1.1.1", DEFAULT_INTRANET_CIDRS)).toBe(false);
    expect(isIpInCidrs("172.32.0.1", DEFAULT_INTRANET_CIDRS)).toBe(false);
    expect(isIpInCidrs("2606:4700:4700::1111", DEFAULT_INTRANET_CIDRS)).toBe(false);
  });

  it("unwraps IPv4-mapped IPv6 addresses so ::ffff:8.8.8.8 cannot bypass IPv4 rules", () => {
    expect(normalizeIpAddress("::ffff:10.0.0.1")).toBe("10.0.0.1");
    expect(normalizeIpAddress("::ffff:0a00:0001")).toBe("10.0.0.1");
    expect(isIpInCidrs("::ffff:10.0.0.1", DEFAULT_INTRANET_CIDRS)).toBe(true);
    expect(isIpInCidrs("::ffff:8.8.8.8", DEFAULT_INTRANET_CIDRS)).toBe(false);
  });
});

describe("@conductor/network-guard policy evaluation and audit chain", () => {
  const mockResolver = async (hostname: string): Promise<readonly string[]> => {
    const table: Record<string, readonly string[]> = {
      "vllm.corp.internal": ["10.20.30.40"],
      "gitlab.corp.internal": ["192.168.10.5"],
      "rebind.corp.internal": ["10.20.30.40", "93.184.216.34"],
      "api.openai.com": ["104.18.7.192"]
    };
    return table[hostname] ?? [];
  };

  it("permits intranet hosts and blocks public IPs or DNS-rebinding hosts with ERR_EGRESS_BLOCKED_BY_POLICY", async () => {
    const evaluator = new NetworkPolicyEvaluator({
      hostResolver: mockResolver,
      allowedHostPatterns: ["localhost", "*.corp.internal"],
      requireAllowedHostnamePattern: true
    });

    const allowed = await evaluator.verifyUrl("https://vllm.corp.internal:8000/v1/chat/completions");
    expect(allowed.resolvedIps).toEqual(["10.20.30.40"]);

    await expect(evaluator.verifyUrl("https://api.openai.com/v1/chat/completions")).rejects.toMatchObject({
      name: "EgressBlockedError",
      code: ERR_EGRESS_BLOCKED_BY_POLICY
    });

    // Even if hostname matches *.corp.internal, resolving to a public IP must be blocked
    await expect(evaluator.verifyUrl("https://rebind.corp.internal/api")).rejects.toBeInstanceOf(
      EgressBlockedError
    );

    // Direct public IP literal must be blocked immediately
    await expect(evaluator.verifyUrl("http://8.8.8.8/dns-query")).rejects.toMatchObject({
      code: ERR_EGRESS_BLOCKED_BY_POLICY
    });

    const records = evaluator.getAuditRecords();
    expect(records).toHaveLength(4);
    expect(records.map((r) => r.payload.decision)).toEqual(["allow", "block", "block", "block"]);
    expect(evaluator.verifyAuditIntegrity()).toBe(true);
  });

  it("intercepts globalThis.fetch and http.get, allowing loopback while blocking public internet", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok-from-loopback" }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const guard = installNetworkGuard({
      hostResolver: mockResolver
    });

    try {
      // Loopback fetch succeeds
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ok-from-loopback" });

      // Public internet fetch is blocked before leaving process
      await expect(fetch("https://api.openai.com/v1/models")).rejects.toMatchObject({
        code: ERR_EGRESS_BLOCKED_BY_POLICY
      });

      // Node http.get with globalAgent to public IP or public hostname is blocked
      await expect(
        new Promise((resolve, reject) => {
          const req = http.get("http://api.openai.com/v1/models", resolve);
          req.on("error", reject);
        })
      ).rejects.toMatchObject({
        code: ERR_EGRESS_BLOCKED_BY_POLICY
      });

      await expect(
        new Promise((resolve, reject) => {
          try {
            const req = http.get("http://8.8.8.8", resolve);
            req.on("error", reject);
          } catch (err) {
            reject(err);
          }
        })
      ).rejects.toMatchObject({
        code: ERR_EGRESS_BLOCKED_BY_POLICY
      });
    } finally {
      guard.uninstall();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("@conductor/network-guard subprocess env sanitization & corporate CA loader", () => {
  it("strips ambient cloud credentials unless explicitly permitted and injects offline flags", () => {
    const dirtyEnv: NodeJS.ProcessEnv = {
      PATH: "/usr/local/bin:/usr/bin",
      OPENAI_API_KEY: "sk-leak-me-not",
      ANTHROPIC_API_KEY: "sk-ant-leak",
      GITHUB_TOKEN: "ghp_secret",
      CUSTOM_CORP_VAR: "keep-me"
    };

    const sanitized = sanitizeSubprocessEnv(dirtyEnv, {
      caBundlePath: "/etc/conductor/corp-ca.pem",
      overrides: {
        LOCAL_LLM_BASE_URL: "http://10.0.0.10:8000/v1"
      }
    });

    expect(sanitized.OPENAI_API_KEY).toBeUndefined();
    expect(sanitized.ANTHROPIC_API_KEY).toBeUndefined();
    expect(sanitized.GITHUB_TOKEN).toBeUndefined();
    expect(sanitized.CUSTOM_CORP_VAR).toBe("keep-me");
    expect(sanitized.DO_NOT_TRACK).toBe("1");
    expect(sanitized.DISABLE_TELEMETRY).toBe("1");
    expect(sanitized.NPM_CONFIG_OFFLINE).toBe("true");
    expect(sanitized.PIP_NO_INDEX).toBe("1");
    expect(sanitized.HF_HUB_OFFLINE).toBe("1");
    expect(sanitized.NODE_EXTRA_CA_CERTS).toBe("/etc/conductor/corp-ca.pem");
    expect(sanitized.LOCAL_LLM_BASE_URL).toBe("http://10.0.0.10:8000/v1");
  });

  it("loads corporate PEM CA certificates and merges them with system root certificates", () => {
    const dir = mkdtempSync(join(tmpdir(), "conductor-ca-"));
    const pemPath = join(dir, "corp-root-ca.pem");
    const fakePem = "-----BEGIN CERTIFICATE-----\nMIIB+TCCAWACCQEwDQYJKoZIhvcNAQELBQAwEjEQMA4GA1UEAwwHQ29ycC1DQTAe\n-----END CERTIFICATE-----\n";
    writeFileSync(pemPath, fakePem, "utf8");

    try {
      const bundle = loadCorporateCaBundle(pemPath);
      expect(bundle.customPem).toContain("-----BEGIN CERTIFICATE-----");
      expect(bundle.mergedCaCertificates.length).toBeGreaterThan(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
