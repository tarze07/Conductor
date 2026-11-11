#!/usr/bin/env node
/**
 * Air-Gapped Bundle Builder Script (`packaging/offline-bundle/build-offline-bundle.mjs`)
 * Generates a self-contained offline installation bundle and verifies SHA-256 + zero-internet compliance.
 */
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@conductor/")) {
      const name = specifier.slice("@conductor/".length);
      const appDist = resolve(repoRoot, "apps", name, "dist", "index.js");
      if (existsSync(appDist)) {
        return { url: pathToFileURL(appDist).href, shortCircuit: true };
      }
      const pkgDist = resolve(repoRoot, "packages", name, "dist", "index.js");
      if (existsSync(pkgDist)) {
        return { url: pathToFileURL(pkgDist).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  }
});

const { buildOfflineBundle, verifyOfflineBundleDirectory } = await import(
  "../../apps/desktop/dist/index.js"
);

const outputDir = resolve(repoRoot, process.argv[2] ?? "dist/offline-bundle");
const internalRegistry =
  process.env.CONDUCTOR_INTERNAL_REGISTRY_URL ??
  "https://artifacts.intranet.corp.local/conductor-releases";

const manifest = buildOfflineBundle({
  outputDir,
  version: "0.1.0",
  internalUpdateRegistryUrl: internalRegistry
});

const verification = verifyOfflineBundleDirectory(outputDir);
if (!verification.valid) {
  console.error("[OfflineBundle] BŁĄD weryfikacji paczki air-gap:", verification.errors);
  process.exit(1);
}

console.log(
  `[OfflineBundle] Wygenerowano i zweryfikowano paczkę Air-Gapped (${verification.checkedFilesCount} plików) w: ${outputDir}`
);
console.log(
  `[OfflineBundle] Obsługiwane formaty: ${manifest.supportedFormats.join(", ")}`
);
