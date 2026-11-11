import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RpcScope } from "@conductor/contracts";
import {
  NetworkPolicyEvaluator,
  sanitizeSubprocessEnv
} from "@conductor/network-guard";
import { acpProviderDriver } from "@conductor/provider-acp";
import { ProviderRegistry, replayProviderDriver } from "@conductor/provider-core";
import { localLlmProviderDriver } from "@conductor/provider-local-llm";
import {
  CheckpointStore,
  ConductorRpcServer,
  EffectWorker,
  EnvironmentAuthService,
  EventSink,
  OrchestratorV2,
  ProjectionMaintenance,
  ProviderTurnRunner,
  SqliteStateStore,
  resolveOrInitEnvironmentId
} from "@conductor/server";
import {
  STRICT_OFFLINE_CSP,
  buildOfflineWebAssets,
  verifyZeroExternalAssets
} from "@conductor/web";

export interface DoctorCheckResult {
  readonly id: string;
  readonly title: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface DoctorReport {
  readonly overallPassed: boolean;
  readonly checks: readonly DoctorCheckResult[];
}

export interface RunDoctorOptions {
  readonly caBundlePath?: string;
  readonly extraAllowedCidrs?: readonly string[];
  readonly localLlmProbeUrls?: readonly string[];
}

/**
 * Implements `conductor doctor --verify-offline`:
 * Verifies NetworkGuard zero-internet policy, subprocess environment sanitization,
 * optional corporate Root CA bundle, Web UI 100% offline bundle & strict CSP,
 * and SHA-256 tamper-evident audit chain integrity.
 */
export async function runConductorDoctor(
  options: RunDoctorOptions = {}
): Promise<DoctorReport> {
  const checks: DoctorCheckResult[] = [];
  const evaluator = new NetworkPolicyEvaluator({
    caBundlePath: options.caBundlePath,
    extraAllowedCidrs: options.extraAllowedCidrs
  });

  // 1. Verify public internet IPv4/IPv6 egress is blocked
  let publicBlocked = false;
  try {
    await evaluator.verifyUrl("https://8.8.8.8/dns-query");
  } catch {
    publicBlocked = true;
  }
  checks.push({
    id: "zero-internet-egress-block",
    title: "Blokada wyjścia do publicznego internetu (8.8.8.8)",
    passed: publicBlocked,
    detail: publicBlocked
      ? "Połączenia do publicznych adresów IP są blokowane przez NetworkPolicyEvaluator"
      : "BŁĄD: Połączenie do publicznego IP nie zostało zablokowane"
  });

  // 2. Verify intranet/loopback egress is allowed
  let intranetAllowed = false;
  try {
    await evaluator.verifyUrl("http://127.0.0.1:8000/v1/models");
    await evaluator.verifyUrl("http://10.20.30.40:8000/v1/models");
    intranetAllowed = true;
  } catch (err) {
    intranetAllowed = false;
    checks.push({
      id: "intranet-egress-allow",
      title: "Dostęp do sieci loopback i intranetu RFC 1918",
      passed: false,
      detail: err instanceof Error ? err.message : String(err)
    });
  }
  if (intranetAllowed) {
    checks.push({
      id: "intranet-egress-allow",
      title: "Dostęp do sieci loopback i intranetu RFC 1918",
      passed: true,
      detail: "Adresy 127.0.0.1 oraz 10.20.30.40 przechodzą walidację polityki intranetowej"
    });
  }

  // 3. Verify subprocess environment sanitization
  const dirtyEnv: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    OPENAI_API_KEY: "sk-leak-check",
    ANTHROPIC_API_KEY: "sk-ant-leak-check"
  };
  const cleanEnv = sanitizeSubprocessEnv(dirtyEnv, {
    caBundlePath: options.caBundlePath
  });
  const envPassed =
    cleanEnv.OPENAI_API_KEY === undefined &&
    cleanEnv.ANTHROPIC_API_KEY === undefined &&
    cleanEnv.CONDUCTOR_OFFLINE_MODE === "1" &&
    cleanEnv.HF_HUB_OFFLINE === "1";

  checks.push({
    id: "subprocess-env-sanitization",
    title: "Sanityzacja zmiennych środowiskowych procesów potomnych",
    passed: envPassed,
    detail: envPassed
      ? "Klucze chmurowe usunięte, ustawiono CONDUCTOR_OFFLINE_MODE=1 oraz HF_HUB_OFFLINE=1"
      : "BŁĄD: Wyciek zmiennych środowiskowych do procesów potomnych"
  });

  // 4. Verify corporate CA bundle if specified
  if (options.caBundlePath) {
    const caExists = existsSync(options.caBundlePath);
    const caValid =
      caExists && readFileSync(options.caBundlePath, "utf8").includes("BEGIN CERTIFICATE");
    checks.push({
      id: "corporate-ca-bundle",
      title: "Wewnętrzny certyfikat Root CA (mTLS / Private PKI)",
      passed: caValid,
      detail: caValid
        ? `Poprawnie wczytano certyfikat CA z ${options.caBundlePath}`
        : `Brak lub niepoprawny plik PEM w ${options.caBundlePath}`
    });
  }

  // 5. Verify Web UI offline bundle & strict CSP
  const rawAssets = buildOfflineWebAssets();
  const bodyMap: Record<string, string> = {};
  for (const [routePath, entry] of Object.entries(rawAssets)) {
    bodyMap[routePath] = entry.body;
  }
  const bundleAudit = verifyZeroExternalAssets(bodyMap);
  const cspPassed = STRICT_OFFLINE_CSP.includes("default-src 'self'") && bundleAudit.valid;
  checks.push({
    id: "web-ui-offline-bundle",
    title: "Paczka Web UI 100% Offline i nagłówek Strict CSP",
    passed: cspPassed,
    detail: cspPassed
      ? "Zero zewnętrznych URL-i w HTML/CSS/JS/SVG oraz aktywny STRICT_OFFLINE_CSP"
      : `Wykryto naruszenia: ${bundleAudit.violations.join("; ")}`
  });

  // 6. Verify tamper-evident SHA-256 audit chain integrity
  const chainIntact = evaluator.verifyAuditIntegrity() && evaluator.getAuditRecords().length >= 3;
  checks.push({
    id: "audit-chain-integrity",
    title: "Integralność łańcucha audytowego SHA-256",
    passed: chainIntact,
    detail: chainIntact
      ? `Zweryfikowano ${evaluator.getAuditRecords().length} wpisów w łańcuchu SHA-256`
      : "Naruszenie integralności łańcucha audytowego"
  });

  return {
    overallPassed: checks.every((c) => c.passed),
    checks
  };
}

export interface StartedConductorDaemon {
  readonly environmentId: string;
  readonly host: string;
  readonly port: number;
  readonly webUiUrl: string;
  readonly bootstrapPairingCode: string;
  readonly pairingUrl: string;
  readonly auth: EnvironmentAuthService;
  readonly orchestrator: OrchestratorV2;
  readonly sink: EventSink;
  readonly effectWorker: EffectWorker;
  readonly registry: ProviderRegistry;
  readonly close: () => Promise<void>;
}

export interface StartConductorOptions {
  readonly dataDir?: string;
  readonly dbPath?: string;
  readonly host?: string;
  readonly port?: number;
  readonly label?: string;
}

/**
 * Implements `conductor start`:
 * Starts the SQLite state store, v2 orchestrator, outbox effect worker, provider registry,
 * 100% offline Web UI asset bundle, and HTTP/WebSocket RPC server.
 */
export async function startConductorDaemon(
  options: StartConductorOptions = {}
): Promise<StartedConductorDaemon> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "conductor-daemon-"));
  const environmentId = resolveOrInitEnvironmentId(dataDir);
  const store = new SqliteStateStore({
    dbPath: options.dbPath ?? ":memory:"
  });
  const sink = new EventSink(store);
  const orchestrator = new OrchestratorV2(sink);
  const effectWorker = new EffectWorker(store);
  effectWorker.recoverAbandonedEffectsOnStartup();
  orchestrator.attachEffectWorker(effectWorker);

  const projectionMaintenance = new ProjectionMaintenance(store, sink);
  const auth = new EnvironmentAuthService(store);
  const checkpointStore = new CheckpointStore();

  const registry = new ProviderRegistry();
  registry.registerDriver(localLlmProviderDriver);
  registry.registerDriver(acpProviderDriver);
  registry.registerDriver(replayProviderDriver);

  new ProviderTurnRunner({
    environmentId,
    sink,
    orchestrator,
    effectWorker,
    registry,
    checkpointStore
  });

  const staticAssets = buildOfflineWebAssets({ defaultEnvironmentId: environmentId });
  const rpcServer = new ConductorRpcServer({
    environmentId,
    sink,
    orchestrator,
    projectionMaintenance,
    auth,
    checkpointStore,
    staticAssets
  });

  const host = options.host ?? "127.0.0.1";
  const port = await rpcServer.listen(options.port ?? 0, host);

  const bootstrap = auth.seedBootstrapPairingGrant({
    label: options.label ?? "conductor-cli-bootstrap"
  });

  const webUiUrl = `http://${host}:${port}/`;
  const pairingUrl = `${webUiUrl}#pair=${encodeURIComponent(
    bootstrap.rawPairingCode
  )}&env=${encodeURIComponent(environmentId)}`;

  return {
    environmentId,
    host,
    port,
    webUiUrl,
    bootstrapPairingCode: bootstrap.rawPairingCode,
    pairingUrl,
    auth,
    orchestrator,
    sink,
    effectWorker,
    registry,
    close: async () => {
      await effectWorker.drain();
      await rpcServer.close();
      store.close();
    }
  };
}

/**
 * Implements `conductor pair`:
 * Generates a fresh one-time pairing grant with optional scope ceiling for a browser or LAN peer.
 */
export function createConductorPairingLink(params: {
  readonly daemon: Pick<StartedConductorDaemon, "auth" | "webUiUrl" | "environmentId">;
  readonly label: string;
  readonly scopes?: readonly RpcScope[];
}): {
  readonly pairingCode: string;
  readonly pairingUrl: string;
  readonly expiresAt: string;
} {
  const grant = params.daemon.auth.seedBootstrapPairingGrant({
    label: params.label,
    scopes: params.scopes
  });

  const pairingUrl = `${params.daemon.webUiUrl}#pair=${encodeURIComponent(
    grant.rawPairingCode
  )}&env=${encodeURIComponent(params.daemon.environmentId)}`;

  return {
    pairingCode: grant.rawPairingCode,
    pairingUrl,
    expiresAt: grant.expiresAt
  };
}
