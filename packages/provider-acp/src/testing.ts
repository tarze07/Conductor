import { AcpProviderSettingsSchema, type AcpProviderSettings } from "./settings.js";

/**
 * Creates an AcpProviderSettings instance that spawns a deterministic inline Node.js
 * JSON-RPC 2.0 ACP responder script for offline unit/integration testing.
 */
export function createMockAcpInstanceSettings(
  instanceId = "acp-mock-1"
): AcpProviderSettings {
  const inlineScript = `
    const readline = require("node:readline");
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      const msg = JSON.parse(line);
      if (msg.method === "initialize") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }) + "\\n");
      } else if (msg.method === "session/prompt") {
        const envCheck = process.env.OPENAI_API_KEY ? "LEAKED" : "CLEAN";
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: { updateType: "delta", textDelta: "ACP offline response (" + envCheck + ")" }
        }) + "\\n");
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: { status: "completed", assistantText: "ACP offline response (" + envCheck + ")" }
        }) + "\\n");
        process.exit(0);
      }
    });
  `;

  return AcpProviderSettingsSchema.parse({
    instanceId,
    driverKind: "acp",
    label: "Mock Local ACP Agent",
    config: {
      command: process.execPath,
      args: ["-e", inlineScript],
      flavor: "opencode-offline",
      allowedEnvKeys: []
    }
  });
}
