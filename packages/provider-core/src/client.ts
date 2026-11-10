import type { z } from "zod";
import type { ProviderPresentation } from "@conductor/contracts";

/**
 * Browser- and mobile-safe provider client definition (modeled after t3code's `ProviderClientDefinition`).
 */
export interface ProviderClientDefinition<
  TSchema extends z.ZodTypeAny = z.ZodTypeAny
> {
  readonly driverKind: string;
  readonly label: string;
  readonly badge?: string;
  readonly iconSvgPath: string;
  readonly settingsSchema: TSchema;
  readonly presentation: ProviderPresentation;
  readonly searchTerms: readonly string[];
}
