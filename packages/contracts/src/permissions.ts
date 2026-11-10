import { z } from "zod";

export const RuntimeModeSchema = z.enum([
  "plan-only",
  "supervised",
  "autonomous-sandbox"
]);
export type RuntimeMode = z.infer<typeof RuntimeModeSchema>;

export const RpcScopeSchema = z.enum([
  "orchestration:read",
  "orchestration:operate",
  "terminal:operate",
  "filesystem:read",
  "access:write"
]);
export type RpcScope = z.infer<typeof RpcScopeSchema>;

/**
 * Authoritative mapping of RPC methods to required authorization scopes,
 * modeled after t3code's `CLIENT_GUARDED_RPC_SCOPES`.
 */
export const CLIENT_GUARDED_RPC_SCOPES = Object.freeze({
  "environment.describe": "orchestration:read",
  "project.list": "orchestration:read",
  "project.register": "orchestration:operate",
  "thread.list": "orchestration:read",
  "thread.get": "orchestration:read",
  "thread.subscribe": "orchestration:read",
  "thread.create": "orchestration:operate",
  "thread.auto-settle": "orchestration:operate",
  "turn.start": "orchestration:operate",
  "turn.cancel": "orchestration:operate",
  "checkpoint.diff": "filesystem:read",
  "checkpoint.restore": "orchestration:operate",
  "runtime-request.respond": "orchestration:operate",
  "terminal.open": "terminal:operate",
  "terminal.write": "terminal:operate",
  "terminal.resize": "terminal:operate",
  "filesystem.readFile": "filesystem:read",
  "access.createPairing": "access:write",
  "access.revokeSession": "access:write"
} as const satisfies Record<string, RpcScope>);

export type GuardedRpcMethod = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

export function hasRequiredRpcScope(
  grantedScopes: readonly RpcScope[],
  method: GuardedRpcMethod,
  modeLimit?: RuntimeMode
): boolean {
  const required = CLIENT_GUARDED_RPC_SCOPES[method];
  if (!grantedScopes.includes(required)) {
    return false;
  }
  // A caller fenced to `plan-only` (e.g. via T3-Mode-Limit on MCP/PeerLinks) cannot execute terminal commands
  if (modeLimit === "plan-only" && required === "terminal:operate") {
    return false;
  }
  return true;
}
