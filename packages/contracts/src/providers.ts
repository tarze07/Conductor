import { z } from "zod";
import { RuntimeModeSchema } from "./permissions.js";

export const DEFAULT_MODEL_SENTINEL = "__DEFAULT_MODEL__" as const;

export const OrchestrationV2ProviderCapabilitiesSchema = z.object({
  fork: z.boolean(),
  rollback: z.boolean(),
  steering: z.boolean(),
  subagents: z.boolean(),
  nativeCheckpoints: z.boolean(),
  streamingToolCalls: z.boolean()
});
export type OrchestrationV2ProviderCapabilities = z.infer<
  typeof OrchestrationV2ProviderCapabilitiesSchema
>;

export const ProviderPresentationSchema = z.object({
  driverKind: z.string().min(1),
  label: z.string().min(1),
  badge: z.string().optional(),
  supportedRuntimeModes: z.array(RuntimeModeSchema).min(1),
  showInteractionModeToggle: z.boolean(),
  capabilities: OrchestrationV2ProviderCapabilitiesSchema
});
export type ProviderPresentation = z.infer<typeof ProviderPresentationSchema>;

export const BaseProviderInstanceSettingsSchema = z.object({
  instanceId: z.string().min(1),
  driverKind: z.string().min(1),
  label: z.string().min(1),
  enabled: z.boolean().default(true),
  baseUrl: z.string().url().optional(),
  caBundlePath: z.string().min(1).optional(),
  defaultModel: z.string().min(1).default(DEFAULT_MODEL_SENTINEL)
});
export type BaseProviderInstanceSettings = z.infer<typeof BaseProviderInstanceSettingsSchema>;

/**
 * Factory helper modeled after t3code's `makeProviderSettingsSchema` in `packages/contracts`.
 * Combines common provider instance fields with driver-specific configuration fields.
 */
export function makeProviderSettingsSchema<
  TDriverKind extends string,
  TConfigShape extends z.ZodRawShape
>(driverKind: TDriverKind, configShape: TConfigShape) {
  return BaseProviderInstanceSettingsSchema.extend({
    driverKind: z.literal(driverKind),
    config: z.object(configShape)
  });
}
