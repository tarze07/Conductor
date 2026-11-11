import { createHmac, timingSafeEqual } from "node:crypto";
import type { RpcScope } from "@conductor/contracts";

export interface CorporateOidcClaims {
  readonly sub: string;
  readonly iss: string;
  readonly aud: string;
  readonly exp: number;
  readonly email?: string;
  readonly groups?: readonly string[];
}

export interface CorporateOidcVerifierOptions {
  readonly expectedIssuer: string;
  readonly expectedAudience: string;
  readonly hmacSharedSecret: string;
  readonly groupScopeMapping?: Readonly<Record<string, readonly RpcScope[]>>;
}

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecodeToString(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64").toString("utf8");
}

/**
 * Helper to mint HS256 OIDC JWTs for internal Keycloak/Dex testing and air-gapped dev servers.
 */
export function signCorporateOidcJwt(
  claims: CorporateOidcClaims,
  hmacSharedSecret: string
): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const sig = createHmac("sha256", hmacSharedSecret).update(signingInput).digest();
  return `${signingInput}.${base64UrlEncode(sig)}`;
}

/**
 * Verifies corporate OIDC / Keycloak / LDAP tokens and maps corporate directory groups
 * (`conductor-admins`, `conductor-operators`, `conductor-viewers`) to `RpcScope[]`.
 */
export class CorporateOidcVerifier {
  private readonly expectedIssuer: string;
  private readonly expectedAudience: string;
  private readonly hmacSharedSecret: string;
  private readonly groupScopeMapping: Readonly<Record<string, readonly RpcScope[]>>;

  constructor(options: CorporateOidcVerifierOptions) {
    this.expectedIssuer = options.expectedIssuer;
    this.expectedAudience = options.expectedAudience;
    this.hmacSharedSecret = options.hmacSharedSecret;
    this.groupScopeMapping = options.groupScopeMapping ?? {
      "conductor-admins": [
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
        "filesystem:read",
        "access:write"
      ],
      "conductor-operators": [
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
        "filesystem:read"
      ],
      "conductor-viewers": ["orchestration:read", "filesystem:read"]
    };
  }

  public verifyAndMapScopes(jwtToken: string): {
    readonly claims: CorporateOidcClaims;
    readonly grantedScopes: readonly RpcScope[];
  } {
    const parts = jwtToken.split(".");
    if (parts.length !== 3) {
      throw new Error("[ERR_OIDC_MALFORMED_TOKEN] Invalid JWT structure");
    }

    const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
    const signingInput = `${headerB64}.${payloadB64}`;
    const expectedSig = base64UrlEncode(
      createHmac("sha256", this.hmacSharedSecret).update(signingInput).digest()
    );

    const a = Buffer.from(sigB64, "utf8");
    const b = Buffer.from(expectedSig, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new Error("[ERR_OIDC_INVALID_SIGNATURE] JWT signature verification failed");
    }

    const claims = JSON.parse(base64UrlDecodeToString(payloadB64)) as CorporateOidcClaims;
    const nowEpoch = Math.floor(Date.now() / 1000);

    if (claims.iss !== this.expectedIssuer) {
      throw new Error(
        `[ERR_OIDC_ISSUER_MISMATCH] Expected issuer '${this.expectedIssuer}', got '${claims.iss}'`
      );
    }

    if (claims.aud !== this.expectedAudience) {
      throw new Error(
        `[ERR_OIDC_AUDIENCE_MISMATCH] Expected audience '${this.expectedAudience}', got '${claims.aud}'`
      );
    }

    if (claims.exp <= nowEpoch) {
      throw new Error("[ERR_OIDC_TOKEN_EXPIRED] OIDC token has expired");
    }

    const scopeSet = new Set<RpcScope>();
    for (const group of claims.groups ?? []) {
      const mapped = this.groupScopeMapping[group];
      if (mapped) {
        for (const s of mapped) {
          scopeSet.add(s);
        }
      }
    }

    if (scopeSet.size === 0) {
      scopeSet.add("orchestration:read");
    }

    return {
      claims,
      grantedScopes: [...scopeSet]
    };
  }
}
