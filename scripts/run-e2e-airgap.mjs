#!/usr/bin/env node
/**
 * Runs the Conductor E2E test suite under strict Air-Gapped (`--network=none`) enforcement.
 * Forces `CONDUCTOR_OFFLINE_MODE=1`, `CONDUCTOR_ALLOW_PUBLIC_EGRESS=0`, and `HF_HUB_OFFLINE=1`.
 */
import { spawnSync } from "node:child_process";

const env = {
  ...process.env,
  CONDUCTOR_OFFLINE_MODE: "1",
  CONDUCTOR_ALLOW_PUBLIC_EGRESS: "0",
  HF_HUB_OFFLINE: "1",
  TRANSFORMERS_OFFLINE: "1",
  DO_NOT_TRACK: "1",
  TELEMETRY_DISABLED: "1"
};

const result = spawnSync("pnpm", ["vitest", "run", "apps/desktop/src/phase6-e2e.test.ts"], {
  stdio: "inherit",
  env
});

process.exit(result.status ?? 1);
