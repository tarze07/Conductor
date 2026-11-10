import type { ProviderClientDefinition } from "@conductor/provider-core/client";
import {
  ACP_PROVIDER_PRESENTATION,
  AcpProviderSettingsSchema
} from "./settings.js";

export const acpProviderClientDefinition: ProviderClientDefinition<typeof AcpProviderSettingsSchema> =
  Object.freeze({
    driverKind: "acp",
    label: ACP_PROVIDER_PRESENTATION.label,
    badge: ACP_PROVIDER_PRESENTATION.badge,
    iconSvgPath: "M5 4h14v16H5V4zm2 4h10v2H7V8zm0 4h6v2H7v-2z",
    settingsSchema: AcpProviderSettingsSchema,
    presentation: ACP_PROVIDER_PRESENTATION,
    searchTerms: ["acp", "opencode", "pi", "cli", "stdio", "jsonrpc"]
  });
