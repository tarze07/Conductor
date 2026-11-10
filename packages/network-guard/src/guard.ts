import http from "node:http";
import https from "node:https";
import { Socket, isIP } from "node:net";
import type { LookupOneOptions } from "node:dns";
import { loadCorporateCaBundle } from "./env.js";
import {
  EgressBlockedError,
  NetworkPolicyEvaluator,
  type NetworkGuardPolicyConfig
} from "./policy.js";

function createGuardedLookup(evaluator: NetworkPolicyEvaluator) {
  return function guardedLookup(
    hostname: string,
    options: LookupOneOptions | number | undefined,
    callback: (err: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void
  ): void {
    const wantsAll = typeof options === "object" && options !== null && Boolean((options as { all?: boolean }).all);
    evaluator
      .verifyHost(hostname)
      .then(({ resolvedIps }) => {
        const firstIp = resolvedIps[0]!;
        const firstFamily = isIP(firstIp) || 4;
        if (wantsAll) {
          const allAddresses = resolvedIps.map((ip) => ({
            address: ip,
            family: isIP(ip) || 4
          }));
          callback(null, allAddresses);
        } else {
          callback(null, firstIp, firstFamily);
        }
      })
      .catch((error: unknown) => {
        const err = error instanceof Error ? (error as NodeJS.ErrnoException) : new Error(String(error));
        callback(err, "", 4);
      });
  };
}

function createBlockedSocket(evaluator: NetworkPolicyEvaluator, hostOnly: string): Socket {
  const socket = new Socket();
  void evaluator.verifyHost(hostOnly).catch(() => {});
  const err = new EgressBlockedError({
    targetHost: hostOnly,
    resolvedIps: [hostOnly],
    reason: `IP address ${hostOnly} is outside allowed intranet/loopback CIDR ranges`
  });
  process.nextTick(() => {
    socket.destroy(err);
  });
  return socket;
}

class GuardedHttpAgent extends http.Agent {
  private readonly evaluator: NetworkPolicyEvaluator;

  constructor(evaluator: NetworkPolicyEvaluator, options: http.AgentOptions = {}) {
    super({
      ...options,
      lookup: createGuardedLookup(evaluator) as http.AgentOptions["lookup"]
    });
    this.evaluator = evaluator;
  }

  public override createConnection(
    options: http.ClientRequestArgs,
    callback?: (err: Error | null, stream: import("node:stream").Duplex) => void
  ): ReturnType<http.Agent["createConnection"]> {
    const rawHost = String(options.hostname ?? options.host ?? "localhost");
    const hostOnly = rawHost.includes(":") && isIP(rawHost) === 0 ? rawHost.split(":")[0]! : rawHost;
    if (isIP(hostOnly) !== 0 && !this.evaluator.isIpAllowed(hostOnly)) {
      return createBlockedSocket(this.evaluator, hostOnly);
    }
    return super.createConnection(options, callback);
  }
}

class GuardedHttpsAgent extends https.Agent {
  private readonly evaluator: NetworkPolicyEvaluator;

  constructor(evaluator: NetworkPolicyEvaluator, options: https.AgentOptions = {}) {
    const caOptions: Partial<https.AgentOptions> = {};
    if (evaluator.caBundlePath) {
      const bundle = loadCorporateCaBundle(evaluator.caBundlePath);
      caOptions.ca = [...bundle.mergedCaCertificates];
    }
    super({
      ...options,
      ...caOptions,
      lookup: createGuardedLookup(evaluator) as https.AgentOptions["lookup"]
    });
    this.evaluator = evaluator;
  }

  public override createConnection(
    options: https.RequestOptions,
    callback?: (err: Error | null, stream: import("node:stream").Duplex) => void
  ): ReturnType<https.Agent["createConnection"]> {
    const rawHost = String(options.hostname ?? options.host ?? "localhost");
    const hostOnly = rawHost.includes(":") && isIP(rawHost) === 0 ? rawHost.split(":")[0]! : rawHost;
    if (isIP(hostOnly) !== 0 && !this.evaluator.isIpAllowed(hostOnly)) {
      return createBlockedSocket(this.evaluator, hostOnly);
    }
    return super.createConnection(options, callback);
  }
}

export function createGuardedHttpAgent(
  evaluator: NetworkPolicyEvaluator,
  agentOptions: http.AgentOptions = {}
): http.Agent {
  return new GuardedHttpAgent(evaluator, agentOptions);
}

export function createGuardedHttpsAgent(
  evaluator: NetworkPolicyEvaluator,
  agentOptions: https.AgentOptions = {}
): https.Agent {
  return new GuardedHttpsAgent(evaluator, agentOptions);
}

export interface InstalledNetworkGuard {
  readonly evaluator: NetworkPolicyEvaluator;
  readonly httpAgent: http.Agent;
  readonly httpsAgent: https.Agent;
  readonly uninstall: () => void;
}

/**
 * Installs process-wide outbound network guards on `globalThis.fetch`,
 * `http.globalAgent`, and `https.globalAgent`.
 */
export function installNetworkGuard(
  configOrEvaluator: NetworkGuardPolicyConfig | NetworkPolicyEvaluator = {}
): InstalledNetworkGuard {
  const evaluator =
    configOrEvaluator instanceof NetworkPolicyEvaluator
      ? configOrEvaluator
      : new NetworkPolicyEvaluator(configOrEvaluator);

  const originalFetch = globalThis.fetch;
  const originalHttpAgent = http.globalAgent;
  const originalHttpsAgent = https.globalAgent;

  const httpAgent = createGuardedHttpAgent(evaluator);
  const httpsAgent = createGuardedHttpsAgent(evaluator);

  http.globalAgent = httpAgent;
  https.globalAgent = httpsAgent;

  const guardedFetch: typeof globalThis.fetch = async (input, init) => {
    const targetUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input
          : input.url;

    await evaluator.verifyUrl(targetUrl);
    return originalFetch(input, init);
  };

  globalThis.fetch = guardedFetch;

  let active = true;
  const uninstall = (): void => {
    if (!active) {
      return;
    }
    active = false;
    globalThis.fetch = originalFetch;
    http.globalAgent = originalHttpAgent;
    https.globalAgent = originalHttpsAgent;
    httpAgent.destroy();
    httpsAgent.destroy();
  };

  return {
    evaluator,
    httpAgent,
    httpsAgent,
    uninstall
  };
}
