import { z } from "zod";
import {
  makeProviderSettingsSchema,
  type ProviderPresentation
} from "@conductor/contracts";

export const AcpProviderSettingsSchema = makeProviderSettingsSchema("acp", {
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  flavor: z
    .enum(["generic-acp", "opencode-offline", "pi-offline"])
    .default("generic-acp"),
  allowedEnvKeys: z.array(z.string()).default([])
});

export type AcpProviderSettings = z.infer<typeof AcpProviderSettingsSchema>;

export const ACP_PROVIDER_PRESENTATION: ProviderPresentation = {
  driverKind: "acp",
  label: "Agent Client Protocol (ACP / OpenCode Offline / Pi)",
  badge: "ACP",
  supportedRuntimeModes: ["plan-only", "supervised", "autonomous-sandbox"],
  showInteractionModeToggle: true,
  capabilities: {
    fork: true,
    rollback: true,
    steering: false,
    subagents: true,
    nativeCheckpoints: false,
    streamingToolCalls: true
  }
};
