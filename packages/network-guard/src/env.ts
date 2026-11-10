import { readFileSync } from "node:fs";
import tls from "node:tls";

/**
 * Environment variables automatically injected into child processes (agents, tools, build steps)
 * to disable telemetry, cloud phone-home checks, and public package index fetches.
 */
export const OFFLINE_ENFORCED_ENV_VARS: Readonly<Record<string, string>> = Object.freeze({
  DO_NOT_TRACK: "1",
  DISABLE_TELEMETRY: "1",
  NEXT_TELEMETRY_DISABLED: "1",
  ASTRO_TELEMETRY_DISABLED: "1",
  NUXT_TELEMETRY_DISABLED: "1",
  GATSBY_TELEMETRY_DISABLED: "1",
  CHECKPOINT_DISABLE: "1",
  NPM_CONFIG_OFFLINE: "true",
  NPM_CONFIG_AUDIT: "false",
  NPM_CONFIG_FUND: "false",
  NPM_CONFIG_UPDATE_NOTIFIER: "false",
  NO_UPDATE_NOTIFIER: "1",
  PIP_NO_INDEX: "1",
  PIP_DISABLE_PIP_VERSION_CHECK: "1",
  HF_HUB_OFFLINE: "1",
  TRANSFORMERS_OFFLINE: "1",
  ANONYMIZED_TELEMETRY: "False",
  CHROMA_TELEMETRY_IMPL: "none",
  CONDUCTOR_OFFLINE_MODE: "1"
});

/**
 * Ambient cloud credential environment variables that must be stripped before spawning
 * provider subprocesses (matching t3code's provider isolation boundary) unless explicitly configured.
 */
export const AMBIENT_CLOUD_CREDENTIAL_KEYS: readonly string[] = Object.freeze([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CURSOR_API_KEY",
  "GROK_API_KEY",
  "XAI_API_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_OPENAI_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN"
]);

export interface SanitizeSubprocessEnvOptions {
  /**
   * Specific credential keys that the provider instance explicitly configured and permits.
   */
  readonly allowedEnvKeys?: readonly string[];
  /**
   * Explicit environment overrides for the child process (e.g., local LLM endpoint URL).
   */
  readonly overrides?: Readonly<Record<string, string>>;
  /**
   * Optional path to corporate Root CA PEM file to inject via `NODE_EXTRA_CA_CERTS`
   * and `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE`.
   */
  readonly caBundlePath?: string;
}

export function sanitizeSubprocessEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  options: SanitizeSubprocessEnvOptions = {}
): Record<string, string> {
  const allowedSet = new Set(options.allowedEnvKeys ?? []);
  const sanitized: Record<string, string> = {};

  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) {
      continue;
    }
    if (AMBIENT_CLOUD_CREDENTIAL_KEYS.includes(key) && !allowedSet.has(key)) {
      continue;
    }
    sanitized[key] = value;
  }

  Object.assign(sanitized, OFFLINE_ENFORCED_ENV_VARS);

  if (options.caBundlePath) {
    sanitized.NODE_EXTRA_CA_CERTS = options.caBundlePath;
    sanitized.SSL_CERT_FILE = options.caBundlePath;
    sanitized.REQUESTS_CA_BUNDLE = options.caBundlePath;
    sanitized.GIT_SSL_CAINFO = options.caBundlePath;
  }

  if (options.overrides) {
    Object.assign(sanitized, options.overrides);
  }

  return sanitized;
}

export interface CorporateCaBundle {
  readonly caBundlePath: string;
  readonly customPem: string;
  readonly mergedCaCertificates: readonly string[];
}

export function loadCorporateCaBundle(caBundlePath: string): CorporateCaBundle {
  const customPem = readFileSync(caBundlePath, "utf8");
  if (!customPem.includes("-----BEGIN CERTIFICATE-----")) {
    throw new Error(`Invalid PEM certificate bundle at path: ${caBundlePath}`);
  }
  const mergedCaCertificates = [...tls.rootCertificates, customPem];
  return {
    caBundlePath,
    customPem,
    mergedCaCertificates
  };
}
