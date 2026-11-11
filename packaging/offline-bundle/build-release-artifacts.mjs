#!/usr/bin/env node
/**
 * Multi-Platform Release Artifact Builder (`packaging/offline-bundle/build-release-artifacts.mjs`)
 * Used by `.github/workflows/release.yml` and local release builds for Linux and Windows.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { registerHooks } from "node:module";
import { join, resolve } from "node:path";
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

function parseArg(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return fallback;
}

const rawVersion = parseArg("--version", process.env.CONDUCTOR_RELEASE_VERSION ?? "0.1.0");
const version = rawVersion.replace(/^v/, "");
const targetPlatform = parseArg("--platform", process.platform);
const targetArch = parseArg("--arch", process.arch);
const releaseOutDir = resolve(repoRoot, parseArg("--out-dir", "dist/release"));

mkdirSync(releaseOutDir, { recursive: true });

const platformLabel = targetPlatform === "win32" ? "win" : targetPlatform;
const bundleFolderName = `conductor-v${version}-${platformLabel}-${targetArch}-airgap`;
const stagingBundleDir = join(releaseOutDir, bundleFolderName);

rmSync(stagingBundleDir, { recursive: true, force: true });
mkdirSync(stagingBundleDir, { recursive: true });

// 1. Generate and verify the offline bundle structure
buildOfflineBundle({
  outputDir: stagingBundleDir,
  version,
  targetPlatform,
  targetArch,
  internalUpdateRegistryUrl:
    process.env.CONDUCTOR_INTERNAL_REGISTRY_URL ??
    "https://artifacts.intranet.corp.local/conductor-releases"
});

const verification = verifyOfflineBundleDirectory(stagingBundleDir);
if (!verification.valid) {
  console.error("[ReleaseBuilder] BŁĄD weryfikacji paczki offline:", verification.errors);
  process.exit(1);
}

// 2. Copy compiled workspace dist artifacts into runtime/ so the archive is executable offline
const runtimeDir = join(stagingBundleDir, "runtime");
mkdirSync(join(runtimeDir, "apps"), { recursive: true });
mkdirSync(join(runtimeDir, "packages"), { recursive: true });

for (const group of ["apps", "packages"]) {
  const groupRoot = join(repoRoot, group);
  for (const entry of readdirSync(groupRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgPath = join(groupRoot, entry.name);
    const distPath = join(pkgPath, "dist");
    const pkgJsonPath = join(pkgPath, "package.json");
    if (existsSync(distPath) && existsSync(pkgJsonPath)) {
      const destPkg = join(runtimeDir, group, entry.name);
      mkdirSync(destPkg, { recursive: true });
      cpSync(distPath, join(destPkg, "dist"), { recursive: true });
      cpSync(pkgJsonPath, join(destPkg, "package.json"));
    }
  }
}

cpSync(join(repoRoot, "INSTALL.md"), join(stagingBundleDir, "INSTALL.md"), { force: true });
cpSync(join(repoRoot, "README.md"), join(stagingBundleDir, "README.md"), { force: true });

function writeSha256File(artifactPath) {
  const bytes = readFileSync(artifactPath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const fileName = artifactPath.split(/[/\\]/).pop();
  writeFileSync(`${artifactPath}.sha256`, `${digest}  ${fileName}\n`, "utf8");
  return digest;
}

const createdArtifacts = [];

// 3. Create .tar.gz archive (works on both Linux and Windows 10/11/Server 2022 via tar)
const tarGzName = `${bundleFolderName}.tar.gz`;
const tarGzPath = join(releaseOutDir, tarGzName);
execFileSync("tar", ["-czf", tarGzPath, "-C", releaseOutDir, bundleFolderName]);
writeSha256File(tarGzPath);
createdArtifacts.push(tarGzPath);

// 4. Platform-specific native archive (.deb on Linux, .zip on Windows)
if (targetPlatform === "linux") {
  try {
    chmodSync(join(stagingBundleDir, "install-airgap.sh"), 0o755);
    chmodSync(join(stagingBundleDir, "packages/appimage/AppRun"), 0o755);
  } catch {
    // Ignore chmod issues on restricted filesystems
  }

  // Build Debian (.deb) package if dpkg-deb is installed on the runner
  const debRoot = join(releaseOutDir, `deb-staging-${version}`);
  try {
    rmSync(debRoot, { recursive: true, force: true });
    mkdirSync(join(debRoot, "DEBIAN"), { recursive: true });
    mkdirSync(join(debRoot, "opt", "conductor"), { recursive: true });

    cpSync(
      join(stagingBundleDir, "packages/deb/DEBIAN/control"),
      join(debRoot, "DEBIAN/control")
    );
    cpSync(stagingBundleDir, join(debRoot, "opt", "conductor"), { recursive: true });

    chmodSync(debRoot, 0o755);
    chmodSync(join(debRoot, "DEBIAN"), 0o755);
    chmodSync(join(debRoot, "DEBIAN/control"), 0o644);

    const debArch = targetArch === "x64" ? "amd64" : targetArch;
    const debFileName = `conductor-intranet_${version}_${debArch}.deb`;
    const debFilePath = join(releaseOutDir, debFileName);
    execFileSync("dpkg-deb", ["--build", "--root-owner-group", debRoot, debFilePath], {
      stdio: "ignore"
    });
    writeSha256File(debFilePath);
    createdArtifacts.push(debFilePath);
  } catch {
    console.log("[ReleaseBuilder] Pominięto budowanie .deb (brak dpkg-deb w środowisku).");
  } finally {
    rmSync(debRoot, { recursive: true, force: true });
  }
} else if (targetPlatform === "win32") {
  const zipName = `${bundleFolderName}.zip`;
  const zipPath = join(releaseOutDir, zipName);
  rmSync(zipPath, { force: true });
  execFileSync("powershell", [
    "-NoProfile",
    "-Command",
    `Compress-Archive -Path '${stagingBundleDir}' -DestinationPath '${zipPath}' -Force`
  ]);
  writeSha256File(zipPath);
  createdArtifacts.push(zipPath);
}

rmSync(stagingBundleDir, { recursive: true, force: true });

console.log(`[ReleaseBuilder] Utworzono artefakty wydania v${version} (${targetPlatform}-${targetArch}):`);
for (const art of createdArtifacts) {
  console.log(`  - ${art}`);
  console.log(`  - ${art}.sha256`);
}
