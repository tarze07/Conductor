import { z } from "zod";
import {
  makeProviderSettingsSchema,
  type ProviderPresentation
} from "@conductor/contracts";

export const LocalLlmSettingsSchema = makeProviderSettingsSchema("local-llm", {
  engineType: z
    .enum(["vllm", "ollama", "litellm", "tgi", "llamacpp"])
    .default("vllm"),
  apiFormat: z
    .enum(["openai-compatible", "anthropic-compatible"])
    .default("openai-compatible"),
  maxSteps: z.number().int().positive().default(12),
  temperature: z.number().min(0).max(2).default(0.1),
  stream: z.boolean().default(true)
});

export type LocalLlmSettings = z.infer<typeof LocalLlmSettingsSchema>;

export const LOCAL_LLM_PRESENTATION: ProviderPresentation = {
  driverKind: "local-llm",
  label: "Local / Intranet LLM (vLLM, Ollama, LiteLLM, TGI)",
  badge: "ON-PREM",
  supportedRuntimeModes: ["plan-only", "supervised", "autonomous-sandbox"],
  showInteractionModeToggle: true,
  capabilities: {
    fork: true,
    rollback: true,
    steering: true,
    subagents: true,
    nativeCheckpoints: false,
    streamingToolCalls: true
  }
};
