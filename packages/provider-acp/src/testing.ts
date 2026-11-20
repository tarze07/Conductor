import type { AcpProviderSettings } from "./settings.js";

export interface MockAcpInstanceOptions {
  readonly loadSession?: boolean;
  readonly mcpHttp?: boolean;
  readonly embeddedContext?: boolean;
  readonly requireAuth?: boolean;
  readonly authMethodId?: string;
  readonly advertiseModes?: boolean;
  readonly initializeTimeoutMs?: number;
  readonly cancelGraceMs?: number;
  readonly fixedSessionId?: string;
}

/**
 * Creates a deterministic, specification-compliant mock ACP v1 CLI agent
 * executed via `process.execPath -e <script>` for offline unit and E2E tests.
 */
export function createMockAcpInstanceSettings(
  instanceId = "acp-mock-instance",
  options: MockAcpInstanceOptions = {}
): AcpProviderSettings {
  const agentConfig = JSON.stringify({
    loadSession: options.loadSession ?? true,
    mcpHttp: options.mcpHttp ?? true,
    embeddedContext: options.embeddedContext ?? false,
    requireAuth: options.requireAuth ?? false,
    advertiseModes: options.advertiseModes ?? true,
    fixedSessionId: options.fixedSessionId ?? null
  });

  const inlineScript = `
    const readline = require("node:readline");
    const cfg = ${agentConfig};
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

    let nextAgentRpcId = 1000;
    let sessionSeq = 0;
    let turnSeq = 0;
    let authenticated = !cfg.requireAuth;
    const pendingAgentRequests = new Map();
    let activePromptReq = null;

    function send(obj) {
      process.stdout.write(JSON.stringify(obj) + "\\n");
    }

    function sendAgentRequest(method, params) {
      const id = ++nextAgentRpcId;
      return new Promise((resolve, reject) => {
        pendingAgentRequests.set(id, { resolve, reject });
        send({ jsonrpc: "2.0", id, method, params });
      });
    }

    function sendSessionUpdate(sessionId, update) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId, update }
      });
    }

    const defaultModes = cfg.advertiseModes
      ? {
          currentModeId: "supervised",
          availableModes: [
            { id: "plan-only", name: "Plan Only" },
            { id: "supervised", name: "Supervised" },
            { id: "autonomous-sandbox", name: "Autonomous Sandbox" }
          ]
        }
      : undefined;

    rl.on("line", async (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }

      // Handle responses to agent-initiated requests (e.g. session/request_permission, fs/*)
      if (msg.id !== undefined && msg.method === undefined) {
        const pending = pendingAgentRequests.get(msg.id);
        if (pending) {
          pendingAgentRequests.delete(msg.id);
          if (msg.error) {
            pending.reject(msg.error);
          } else {
            pending.resolve(msg.result);
          }
        }
        return;
      }

      // Handle notifications from client (session/cancel)
      if (msg.method === "session/cancel" && msg.id === undefined) {
        if (activePromptReq && !activePromptReq.hangOnCancel) {
          const reqToCancel = activePromptReq;
          activePromptReq = null;
          send({
            jsonrpc: "2.0",
            id: reqToCancel.id,
            result: { stopReason: "cancelled" }
          });
        }
        return;
      }

      if (msg.method === "initialize") {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: {
              loadSession: cfg.loadSession,
              promptCapabilities: {
                embeddedContext: cfg.embeddedContext
              },
              mcpCapabilities: {
                http: cfg.mcpHttp
              }
            },
            authMethods: cfg.requireAuth
              ? [{ id: "corp-token", name: "Corporate Offline Token" }]
              : [],
            agentInfo: {
              name: "conductor-mock-acp",
              version: "1.0.0"
            }
          }
        });
        return;
      }

      if (msg.method === "authenticate") {
        authenticated = true;
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: {}
        });
        return;
      }

      if (msg.method === "session/new") {
        if (!authenticated) {
          send({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32002, message: "Authentication required before session/new" }
          });
          return;
        }
        const sessionId = cfg.fixedSessionId || ("sess_acp_" + (++sessionSeq) + "_" + process.pid);
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            sessionId,
            ...(defaultModes ? { modes: defaultModes } : {})
          }
        });
        return;
      }

      if (msg.method === "session/load") {
        const sessionId = msg.params.sessionId;
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            ...(defaultModes ? { modes: defaultModes } : {})
          }
        });
        return;
      }

      if (msg.method === "session/set_mode") {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: {}
        });
        return;
      }

      if (msg.method === "session/prompt") {
        turnSeq += 1;
        const sessionId = msg.params.sessionId;
        const blocks = Array.isArray(msg.params.prompt) ? msg.params.prompt : [];
        const combinedText = blocks
          .map((b) => (b.type === "text" ? b.text : b.type === "resource" ? b.resource.text : b.uri || ""))
          .join("\\n");

        if (combinedText.includes("scenario:refusal")) {
          send({
            jsonrpc: "2.0",
            id: msg.id,
            result: { stopReason: "refusal" }
          });
          return;
        }

        if (combinedText.includes("scenario:cancel_hang")) {
          activePromptReq = { id: msg.id, sessionId, hangOnCancel: true };
          sendSessionUpdate(sessionId, {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "Hanging turn waiting for force kill..." }
          });
          return;
        }

        if (combinedText.includes("scenario:cancel_graceful")) {
          activePromptReq = { id: msg.id, sessionId, hangOnCancel: false };
          // Also open a permission request so test can cancel while permission is pending
          try {
            const permRes = await sendAgentRequest("session/request_permission", {
              sessionId,
              toolCall: {
                toolCallId: "tc_cancel_perm",
                title: "Long running command",
                kind: "execute",
                status: "pending"
              },
              options: [
                { optionId: "allow_once_id", name: "Allow once", kind: "allow_once" },
                { optionId: "reject_once_id", name: "Reject once", kind: "reject_once" }
              ]
            });
            if (permRes && permRes.outcome && permRes.outcome.outcome === "cancelled" && activePromptReq) {
              const reqToFinish = activePromptReq;
              activePromptReq = null;
              send({
                jsonrpc: "2.0",
                id: reqToFinish.id,
                result: { stopReason: "cancelled" }
              });
            }
          } catch {
            // Ignore
          }
          return;
        }

        if (combinedText.includes("scenario:permission")) {
          const permRes = await sendAgentRequest("session/request_permission", {
            sessionId,
            toolCall: {
              toolCallId: "tc_perm_1",
              title: "Modify configuration file",
              kind: "edit",
              status: "pending",
              rawInput: { file: "config.json" }
            },
            options: [
              { optionId: "opt_allow_once", name: "Zezwól raz", kind: "allow_once" },
              { optionId: "opt_reject_once", name: "Odrzuć", kind: "reject_once" }
            ]
          });

          if (permRes.outcome.outcome === "cancelled") {
            send({
              jsonrpc: "2.0",
              id: msg.id,
              result: { stopReason: "cancelled" }
            });
            return;
          }

          sendSessionUpdate(sessionId, {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "Permission outcome: " + permRes.outcome.outcome + ":" + permRes.outcome.optionId
            }
          });
          send({
            jsonrpc: "2.0",
            id: msg.id,
            result: { stopReason: "end_turn" }
          });
          return;
        }

        const fsReadMatch = combinedText.match(/scenario:fs_read:([^\\s]+)/);
        if (fsReadMatch) {
          const targetPath = fsReadMatch[1];
          try {
            const readRes = await sendAgentRequest("fs/read_text_file", {
              sessionId,
              path: targetPath
            });
            sendSessionUpdate(sessionId, {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "READ_OK:" + readRes.content }
            });
          } catch (err) {
            sendSessionUpdate(sessionId, {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "READ_ERR:" + (err.message || JSON.stringify(err)) }
            });
          }
          send({
            jsonrpc: "2.0",
            id: msg.id,
            result: { stopReason: "end_turn" }
          });
          return;
        }

        const fsWriteMatch = combinedText.match(/scenario:fs_write:([^:]+):(.+)/);
        if (fsWriteMatch) {
          const targetPath = fsWriteMatch[1];
          const contentToWrite = fsWriteMatch[2];
          try {
            await sendAgentRequest("fs/write_text_file", {
              sessionId,
              path: targetPath,
              content: contentToWrite
            });
            sendSessionUpdate(sessionId, {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "WRITE_OK:" + targetPath }
            });
          } catch (err) {
            sendSessionUpdate(sessionId, {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "WRITE_ERR:" + (err.message || JSON.stringify(err)) }
            });
          }
          send({
            jsonrpc: "2.0",
            id: msg.id,
            result: { stopReason: "end_turn" }
          });
          return;
        }

        if (combinedText.includes("scenario:terminal_unsupported")) {
          try {
            await sendAgentRequest("terminal/create", {
              sessionId,
              command: "echo",
              args: ["hello"]
            });
          } catch (err) {
            sendSessionUpdate(sessionId, {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "TERMINAL_ERR_CODE:" + String(err.code) }
            });
          }
          send({
            jsonrpc: "2.0",
            id: msg.id,
            result: { stopReason: "end_turn" }
          });
          return;
        }

        // Standard ACP turn sequence:
        // 1. agent_thought_chunk
        sendSessionUpdate(sessionId, {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Analizuję zapytanie w sesji " + sessionId }
        });

        // 2. plan
        sendSessionUpdate(sessionId, {
          sessionUpdate: "plan",
          entries: [
            { content: "Sprawdzenie środowiska pracy", priority: "high", status: "completed" }
          ]
        });

        // 3. tool_call (in_progress)
        const toolCallId = "tc_" + turnSeq;
        sendSessionUpdate(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId,
          title: "inspect_workspace",
          kind: "read",
          status: "in_progress",
          rawInput: { turn: turnSeq }
        });

        // 4. Separate in time: tool_call_update (completed)
        await new Promise((r) => setTimeout(r, 15));
        sendSessionUpdate(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "completed",
          rawOutput: { ok: true, pid: process.pid }
        });

        // 5. Unknown sessionUpdate (should be ignored gracefully by client)
        sendSessionUpdate(sessionId, {
          sessionUpdate: "unknown_future_acp_event",
          foo: "bar"
        });

        // 6. agent_message_chunk
        const leakedKey = process.env.OPENAI_API_KEY ? "LEAKED" : "CLEAN";
        const offlineFlag = process.env.CONDUCTOR_OFFLINE_MODE === "1" ? "OFFLINE=1" : "OFFLINE=0";
        sendSessionUpdate(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "ACP offline response (" + leakedKey + ", " + offlineFlag + ") [pid=" + process.pid + ", session=" + sessionId + ", turn=" + turnSeq + "] for: " + combinedText
          }
        });

        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            stopReason: "end_turn"
          }
        });
      }
    });
  `;

  return {
    instanceId,
    driverKind: "acp",
    label: "Mock Local ACP CLI Agent",
    enabled: true,
    defaultModel: "acp-local-model",
    config: {
      command: process.execPath,
      args: ["-e", inlineScript],
      env: {},
      initializeTimeoutMs: options.initializeTimeoutMs ?? 10000,
      cancelGraceMs: options.cancelGraceMs ?? 3000,
      ...(options.authMethodId ? { authMethodId: options.authMethodId } : {})
    }
  };
}
