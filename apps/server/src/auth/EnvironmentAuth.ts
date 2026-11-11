import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  RpcScopeSchema,
  type GuardedRpcMethod,
  type RpcScope,
  type RuntimeMode,
  hasRequiredRpcScope,
  CLIENT_GUARDED_RPC_SCOPES
} from "@conductor/contracts";
import type { SqliteStateStore } from "../persistence/SqliteStateStore.js";

export const DEFAULT_ADMIN_SCOPES: readonly RpcScope[] = Object.freeze([
  "orchestration:read",
  "orchestration:operate",
  "terminal:operate",
  "filesystem:read",
  "access:write"
]);

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Atomically initializes or repairs the environment ID in `dataDir`,
 * retaining a recovery file so concurrent initializers choose the same winner
 * (matching t3code's `ServerEnvironment.ts` invariant).
 */
export function resolveOrInitEnvironmentId(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const idFile = join(dataDir, "environment-id");
  const recoveryFile = join(dataDir, "environment-id.recovery");

  if (existsSync(idFile)) {
    const existing = readFileSync(idFile, "utf8").trim();
    if (existing.length > 0) {
      return existing;
    }
  }

  if (existsSync(recoveryFile)) {
    const recovered = readFileSync(recoveryFile, "utf8").trim();
    if (recovered.length > 0) {
      writeFileSync(idFile, `${recovered}\n`, "utf8");
      return recovered;
    }
  }

  const newId = `env_${randomUUID().replace(/-/g, "")}`;
  writeFileSync(recoveryFile, `${newId}\n`, "utf8");
  const tempFile = join(dataDir, `.environment-id.tmp.${process.pid}`);
  writeFileSync(tempFile, `${newId}\n`, "utf8");
  renameSync(tempFile, idFile);
  return newId;
}

export interface PairingGrantMetadata {
  readonly pairingId: string;
  readonly label: string;
  readonly scopes: readonly RpcScope[];
  readonly modeCeiling?: RuntimeMode;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly consumed: boolean;
}

export interface CreatedPairingGrant extends PairingGrantMetadata {
  /**
   * Returned ONLY at creation time; never stored in plaintext or exposed in read models.
   */
  readonly rawPairingCode: string;
}

export interface AuthenticatedSession {
  readonly sessionId: string;
  readonly subject: string;
  readonly scopes: readonly RpcScope[];
  readonly modeCeiling?: RuntimeMode;
  readonly dpopJkt?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

interface WebSocketTicketRecord {
  readonly ticketId: string;
  readonly session: AuthenticatedSession;
  readonly route: "rpc" | "media";
  readonly dpopJkt?: string;
  readonly expiresAtMs: number;
}

export class AuthorizationDeniedError extends Error {
  public readonly code: string;
  public readonly requiredScope?: RpcScope;
  public readonly requiredPermission?: string;

  constructor(params: {
    readonly code: string;
    readonly message: string;
    readonly requiredScope?: RpcScope;
    readonly requiredPermission?: string;
  }) {
    super(params.message);
    this.name = "AuthorizationDeniedError";
    this.code = params.code;
    this.requiredScope = params.requiredScope;
    this.requiredPermission = params.requiredPermission;
  }
}

export class EnvironmentAuthService {
  private readonly store: SqliteStateStore;
  private readonly tickets = new Map<string, WebSocketTicketRecord>();
  private readonly usedDpopJtis = new Set<string>();

  constructor(store: SqliteStateStore) {
    this.store = store;
  }

  /**
   * Seeds a bootstrap pairing grant (e.g. startup pairing URL or admin CLI token).
   */
  public seedBootstrapPairingGrant(params: {
    readonly label?: string;
    readonly scopes?: readonly RpcScope[];
    readonly modeCeiling?: RuntimeMode;
    readonly ttlSeconds?: number;
  } = {}): CreatedPairingGrant {
    return this.insertPairingGrant({
      label: params.label ?? "bootstrap-admin",
      scopes: params.scopes ?? DEFAULT_ADMIN_SCOPES,
      modeCeiling: params.modeCeiling,
      ttlSeconds: params.ttlSeconds ?? 3600
    });
  }

  /**
   * Delegates a new pairing grant from an existing caller session.
   * Enforces t3code's rule: "Creating another pairing link requires both `access:write`
   * and every scope being delegated."
   */
  public createDelegatedPairingGrant(params: {
    readonly callerSession: AuthenticatedSession;
    readonly label: string;
    readonly delegatedScopes: readonly RpcScope[];
    readonly modeCeiling?: RuntimeMode;
    readonly ttlSeconds?: number;
  }): CreatedPairingGrant {
    const { callerSession, label, delegatedScopes, modeCeiling, ttlSeconds } = params;
    if (!callerSession.scopes.includes("access:write")) {
      throw new AuthorizationDeniedError({
        code: "ERR_MISSING_SCOPE",
        message: "Creating a pairing grant requires 'access:write' scope",
        requiredScope: "access:write",
        requiredPermission: "access:write"
      });
    }

    for (const scope of delegatedScopes) {
      if (!callerSession.scopes.includes(scope)) {
        throw new AuthorizationDeniedError({
          code: "ERR_SCOPE_ESCALATION_DENIED",
          message: `Caller cannot delegate scope '${scope}' that it does not hold`,
          requiredScope: scope,
          requiredPermission: scope
        });
      }
    }

    return this.insertPairingGrant({
      label,
      scopes: delegatedScopes,
      modeCeiling: modeCeiling ?? callerSession.modeCeiling,
      ttlSeconds: ttlSeconds ?? 900
    });
  }

  /**
   * Read model of pairing metadata — never includes recoverable pairing secrets.
   */
  public listPairingMetadata(): readonly PairingGrantMetadata[] {
    const rows = this.store.db
      .prepare(
        `SELECT pairing_id, label, scopes_json, mode_ceiling, created_at, expires_at, consumed
         FROM pairing_grants ORDER BY created_at DESC`
      )
      .all() as Array<{
      pairing_id: string;
      label: string;
      scopes_json: string;
      mode_ceiling: RuntimeMode | null;
      created_at: string;
      expires_at: string;
      consumed: number;
    }>;

    return rows.map((row) => ({
      pairingId: row.pairing_id,
      label: row.label,
      scopes: JSON.parse(row.scopes_json) as RpcScope[],
      modeCeiling: row.mode_ceiling ?? undefined,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      consumed: Boolean(row.consumed)
    }));
  }

  /**
   * Exchanges a one-time pairing code for a scoped session token.
   * Intersects recognized requested scopes with the pairing grant;
   * fails without consuming the grant if the intersection is empty.
   */
  public exchangePairingCode(params: {
    readonly rawPairingCode: string;
    readonly requestedScopes?: readonly string[];
    readonly subject?: string;
    readonly dpopJkt?: string;
    readonly sessionTtlSeconds?: number;
  }): { readonly rawAccessToken: string; readonly session: AuthenticatedSession } {
    const codeHash = sha256Hex(params.rawPairingCode);
    const nowIso = new Date().toISOString();

    return this.store.inTransaction(() => {
      const grantRow = this.store.db
        .prepare(
          `SELECT pairing_id, scopes_json, mode_ceiling, expires_at, consumed
           FROM pairing_grants WHERE code_hash = ?`
        )
        .get(codeHash) as
        | {
            pairing_id: string;
            scopes_json: string;
            mode_ceiling: RuntimeMode | null;
            expires_at: string;
            consumed: number;
          }
        | undefined;

      if (!grantRow) {
        throw new AuthorizationDeniedError({
          code: "ERR_INVALID_PAIRING_CODE",
          message: "Invalid pairing code"
        });
      }

      if (grantRow.consumed) {
        throw new AuthorizationDeniedError({
          code: "ERR_PAIRING_CODE_CONSUMED",
          message: "Pairing code has already been consumed"
        });
      }

      if (grantRow.expires_at < nowIso) {
        throw new AuthorizationDeniedError({
          code: "ERR_PAIRING_CODE_EXPIRED",
          message: "Pairing code has expired"
        });
      }

      const grantScopes = JSON.parse(grantRow.scopes_json) as RpcScope[];
      let grantedScopes: RpcScope[];

      if (params.requestedScopes && params.requestedScopes.length > 0) {
        const recognizedRequested = params.requestedScopes.filter(
          (s): s is RpcScope => RpcScopeSchema.safeParse(s).success
        );
        grantedScopes = recognizedRequested.filter((s) => grantScopes.includes(s));
      } else {
        grantedScopes = [...grantScopes];
      }

      if (grantedScopes.length === 0) {
        throw new AuthorizationDeniedError({
          code: "ERR_NO_GRANTED_SCOPES",
          message: "Requested scopes have empty intersection with pairing grant"
        });
      }

      // Mark one-time pairing grant as consumed
      this.store.db
        .prepare("UPDATE pairing_grants SET consumed = 1 WHERE pairing_id = ?")
        .run(grantRow.pairing_id);

      const sessionId = `sess_${randomUUID().replace(/-/g, "")}`;
      const rawAccessToken = `cond_tok_${randomBytes(24).toString("hex")}`;
      const tokenHash = sha256Hex(rawAccessToken);
      const ttlSeconds = params.sessionTtlSeconds ?? 86400 * 7;
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
      const subject = params.subject ?? "paired-client";

      this.store.db
        .prepare(
          `INSERT INTO auth_sessions (
             session_id, subject, token_hash, dpop_jkt, scopes_json,
             mode_ceiling, created_at, expires_at, revoked
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
        )
        .run(
          sessionId,
          subject,
          tokenHash,
          params.dpopJkt ?? null,
          JSON.stringify(grantedScopes),
          grantRow.mode_ceiling,
          nowIso,
          expiresAt
        );

      const session: AuthenticatedSession = {
        sessionId,
        subject,
        scopes: grantedScopes,
        modeCeiling: grantRow.mode_ceiling ?? undefined,
        dpopJkt: params.dpopJkt,
        createdAt: nowIso,
        expiresAt
      };

      return {
        rawAccessToken,
        session
      };
    });
  }

  public authenticateToken(
    rawAccessToken: string,
    dpopProof?: { readonly jkt: string; readonly jti: string }
  ): AuthenticatedSession {
    const tokenHash = sha256Hex(rawAccessToken);
    const nowIso = new Date().toISOString();

    const row = this.store.db
      .prepare(
        `SELECT session_id, subject, dpop_jkt, scopes_json, mode_ceiling,
                created_at, expires_at, revoked
         FROM auth_sessions WHERE token_hash = ?`
      )
      .get(tokenHash) as
      | {
          session_id: string;
          subject: string;
          dpop_jkt: string | null;
          scopes_json: string;
          mode_ceiling: RuntimeMode | null;
          created_at: string;
          expires_at: string;
          revoked: number;
        }
      | undefined;

    if (!row || row.revoked || row.expires_at < nowIso) {
      throw new AuthorizationDeniedError({
        code: "ERR_INVALID_SESSION",
        message: "Session token is invalid, expired, or revoked"
      });
    }

    // If session is DPoP-bound, a valid non-replayed proof is mandatory (never falls back to bearer)
    if (row.dpop_jkt) {
      if (!dpopProof || dpopProof.jkt !== row.dpop_jkt) {
        throw new AuthorizationDeniedError({
          code: "ERR_DPOP_PROOF_INVALID",
          message: "DPoP-bound session requires a matching DPoP proof key"
        });
      }
      if (this.usedDpopJtis.has(dpopProof.jti)) {
        throw new AuthorizationDeniedError({
          code: "ERR_DPOP_PROOF_REPLAYED",
          message: "DPoP proof jti has already been consumed"
        });
      }
      this.usedDpopJtis.add(dpopProof.jti);
    }

    return {
      sessionId: row.session_id,
      subject: row.subject,
      scopes: JSON.parse(row.scopes_json) as RpcScope[],
      modeCeiling: row.mode_ceiling ?? undefined,
      dpopJkt: row.dpop_jkt ?? undefined,
      createdAt: row.created_at,
      expiresAt: row.expires_at
    };
  }

  /**
   * Mints a short-lived one-time WebSocket ticket so long-lived tokens never appear in socket URLs.
   */
  public issueWebSocketTicket(params: {
    readonly rawAccessToken: string;
    readonly route: "rpc" | "media";
    readonly dpopProof?: { readonly jkt: string; readonly jti: string };
    readonly ttlMs?: number;
  }): { readonly ticket: string; readonly expiresAtMs: number } {
    const session = this.authenticateToken(params.rawAccessToken, params.dpopProof);
    if (session.subject === "mcp-client") {
      throw new AuthorizationDeniedError({
        code: "ERR_MCP_SUBJECT_FORBIDDEN_ON_RPC",
        message: "Sessions with subject 'mcp-client' are restricted to /mcp"
      });
    }

    const ticket = `wst_${randomBytes(18).toString("hex")}`;
    const expiresAtMs = Date.now() + (params.ttlMs ?? 30_000);
    this.tickets.set(ticket, {
      ticketId: ticket,
      session,
      route: params.route,
      dpopJkt: session.dpopJkt,
      expiresAtMs
    });

    return { ticket, expiresAtMs };
  }

  public consumeWebSocketTicket(params: {
    readonly ticket: string;
    readonly expectedRoute: "rpc" | "media";
    readonly dpopProof?: { readonly jkt: string; readonly jti: string };
  }): AuthenticatedSession {
    const rec = this.tickets.get(params.ticket);
    this.tickets.delete(params.ticket);

    if (!rec || rec.expiresAtMs < Date.now()) {
      throw new AuthorizationDeniedError({
        code: "ERR_INVALID_WS_TICKET",
        message: "WebSocket ticket is invalid or expired"
      });
    }

    if (rec.route !== params.expectedRoute) {
      throw new AuthorizationDeniedError({
        code: "ERR_WS_TICKET_ROUTE_MISMATCH",
        message: `WebSocket ticket is bound to route '${rec.route}', not '${params.expectedRoute}'`
      });
    }

    if (rec.dpopJkt) {
      if (!params.dpopProof || params.dpopProof.jkt !== rec.dpopJkt) {
        throw new AuthorizationDeniedError({
          code: "ERR_DPOP_PROOF_INVALID",
          message: "DPoP-bound WebSocket ticket requires matching DPoP proof on upgrade"
        });
      }
      if (this.usedDpopJtis.has(params.dpopProof.jti)) {
        throw new AuthorizationDeniedError({
          code: "ERR_DPOP_PROOF_REPLAYED",
          message: "DPoP proof jti on WebSocket upgrade has already been consumed"
        });
      }
      this.usedDpopJtis.add(params.dpopProof.jti);
    }

    return rec.session;
  }

  public authorizeRpcMethod(session: AuthenticatedSession, method: GuardedRpcMethod): void {
    const requiredScope = CLIENT_GUARDED_RPC_SCOPES[method];
    if (!hasRequiredRpcScope(session.scopes, method, session.modeCeiling)) {
      throw new AuthorizationDeniedError({
        code: "ERR_INSUFFICIENT_SCOPE",
        message: `Session lacks required scope '${requiredScope}' for RPC method '${method}'`,
        requiredScope,
        requiredPermission: requiredScope
      });
    }
  }

  public revokeSession(sessionId: string): void {
    this.store.db
      .prepare("UPDATE auth_sessions SET revoked = 1 WHERE session_id = ?")
      .run(sessionId);
  }

  private insertPairingGrant(params: {
    readonly label: string;
    readonly scopes: readonly RpcScope[];
    readonly modeCeiling?: RuntimeMode;
    readonly ttlSeconds: number;
  }): CreatedPairingGrant {
    const pairingId = `pair_${randomUUID().replace(/-/g, "")}`;
    const rawPairingCode = `cond_pair_${randomBytes(20).toString("hex")}`;
    const codeHash = sha256Hex(rawPairingCode);
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + params.ttlSeconds * 1000).toISOString();

    this.store.db
      .prepare(
        `INSERT INTO pairing_grants (
           pairing_id, code_hash, label, scopes_json, mode_ceiling,
           created_at, expires_at, consumed
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
      )
      .run(
        pairingId,
        codeHash,
        params.label,
        JSON.stringify(params.scopes),
        params.modeCeiling ?? null,
        createdAt,
        expiresAt
      );

    return {
      pairingId,
      label: params.label,
      scopes: [...params.scopes],
      modeCeiling: params.modeCeiling,
      createdAt,
      expiresAt,
      consumed: false,
      rawPairingCode
    };
  }
}
