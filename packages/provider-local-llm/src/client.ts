import type { ProviderClientDefinition } from "@conductor/provider-core/client";
import {
  LOCAL_LLM_PRESENTATION,
  LocalLlmSettingsSchema
} from "./settings.js";

export const localLlmClientDefinition: ProviderClientDefinition<typeof LocalLlmSettingsSchema> =
  Object.freeze({
    driverKind: "local-llm",
    label: LOCAL_LLM_PRESENTATION.label,
    badge: LOCAL_LLM_PRESENTATION.badge,
    iconSvgPath: "M4 6h16v4H4V6zm0 8h16v4H4v-4z",
    settingsSchema: LocalLlmSettingsSchema,
    presentation: LOCAL_LLM_PRESENTATION,
    searchTerms: ["vllm", "ollama", "litellm", "tgi", "llamacpp", "local", "intranet", "on-prem"]
  });
