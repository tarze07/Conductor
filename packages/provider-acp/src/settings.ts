import { z } from "zod";
import {
  BaseProviderInstanceSettingsSchema,
  type ProviderPresentation,
  type RuntimeMode
} from "@conductor/contracts";
import type { AcpSessionModeState } from "./schema/acp-v1.gen.js";

export const AcpProviderConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  cwd: z.string().optional(),
  initializeTimeoutMs: z.number().int().positive().default(10000),
  cancelGraceMs: z.number().int().positive().default(3000),
  authMethodId: z.string().optional(),
  flavor: z.string().optional(),
  workingDirectoryOverride: z.string().optional()
});

export type AcpProviderConfig = z.infer<typeof AcpProviderConfigSchema>;

export const AcpProviderSettingsSchema = BaseProviderInstanceSettingsSchema.extend({
  driverKind: z.literal("acp"),
  config: AcpProviderConfigSchema
});

export type AcpProviderSettings = z.infer<typeof AcpProviderSettingsSchema>;

/**
 * Default presentation for a generic ACP v1 agent.
 *
 * Per Conductor's RuntimePolicy ("Offer only modes the provider enforces natively"):
 * - `plan-only` is enforced by Conductor rejecting `fs/write_text_file` and mutating `session/request_permission` calls.
 * - `supervised` is enforced by routing `session/request_permission` and `fs/write_text_file` through `host.requestApproval`.
 * - `autonomous-sandbox` is only offered when the agent advertises a matching sandbox/auto mode via `session/new` or `session/load` `modes`.
 * - `fork: false` and `subagents: false` (not part of ACP v1 core), `rollback: true` (enforced via Conductor's Git `CheckpointStore`).
 */
export const ACP_PROVIDER_PRESENTATION: ProviderPresentation = {
  driverKind: "acp",
  label: "Agent Client Protocol (Local CLI)",
  badge: "ACP v1 Stdio",
  supportedRuntimeModes: ["plan-only", "supervised"],
  showInteractionModeToggle: true,
  capabilities: {
    fork: false,
    rollback: true,
    steering: false,
    subagents: false,
    nativeCheckpoints: false,
    streamingToolCalls: true
  }
};

/**
 * Derives updated `ProviderPresentation` if the ACP agent advertises `modes` in `session/new` or `session/load`.
 */
export function deriveAcpPresentationFromSessionModes(
  base: ProviderPresentation,
  modes?: AcpSessionModeState | null
): ProviderPresentation {
  if (!modes || modes.availableModes.length === 0) {
    return base;
  }
  const availableIds = new Set(modes.availableModes.map((m) => m.id.toLowerCase()));
  const supported: RuntimeMode[] = ["plan-only", "supervised"];
  if (
    availableIds.has("autonomous-sandbox") ||
    availableIds.has("auto") ||
    availableIds.has("autonomous") ||
    availableIds.has("bypasspermissions")
  ) {
    supported.push("autonomous-sandbox");
  }
  return {
    ...base,
    supportedRuntimeModes: supported
  };
}
