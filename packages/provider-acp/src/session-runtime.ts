import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { PathTraversalError, resolveSafeWorkspacePath } from "@conductor/agent-core";
import { sanitizeSubprocessEnv } from "@conductor/network-guard";
import type {
  ProviderHost,
  ProviderTurnInput,
  ProviderTurnOutcome
} from "@conductor/provider-core";
import {
  ACP_LATEST_PROTOCOL_VERSION,
  AcpAuthenticateRequestSchema,
  AcpAuthenticateResponseSchema,
  AcpCancelNotificationSchema,
  AcpInitializeRequestSchema,
  AcpInitializeResponseSchema,
  AcpLoadSessionRequestSchema,
  AcpLoadSessionResponseSchema,
  AcpNewSessionRequestSchema,
  AcpNewSessionResponseSchema,
  AcpPromptRequestSchema,
  AcpPromptResponseSchema,
  AcpReadTextFileRequestSchema,
  AcpRequestPermissionRequestSchema,
  AcpSessionNotificationSchema,
  AcpSetSessionModeRequestSchema,
  AcpSetSessionModeResponseSchema,
  AcpWriteTextFileRequestSchema,
  type AcpAgentCapabilities,
  type AcpAuthMethod,
  type AcpContentBlock,
  type AcpMcpServer,
  type AcpReadTextFileRequest,
  type AcpReadTextFileResponse,
  type AcpRequestPermissionRequest,
  type AcpRequestPermissionResponse,
  type AcpSessionModeState,
  type AcpSessionNotification,
  type AcpWriteTextFileRequest,
  type AcpWriteTextFileResponse
} from "./schema/acp-v1.gen.js";
import {
  AcpJsonRpcConnection,
  AcpJsonRpcError,
  JSONRPC_ERROR_INTERNAL,
  JSONRPC_ERROR_PERMISSION_DENIED
} from "./jsonrpc.js";
import type { AcpProviderSettings } from "./settings.js";

/**
 * Terminates a spawned ACP child process and its entire process tree across Linux/POSIX and Windows.
 */
export function killProcessTree(child: ChildProcessWithoutNullStreams): void {
  const pid = child.pid;
  if (!pid) {
    return;
  }

  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // Fallback if taskkill is unavailable
    }
    try {
      child.kill("SIGKILL");
    } catch {
      // Ignore if already dead
    }
    return;
  }

  try {
    child.kill("SIGTERM");
  } catch {
    // Ignore if already exited
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Ignore if already exited
  }
}

function extractFileRefsFromPrompt(promptText: string): readonly string[] {
  const regex = /(?:^|\s)@([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)\b/g;
  const seen = new Set<string>();
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(promptText)) !== null) {
    const rel = match[1]!;
    if (!seen.has(rel)) {
      seen.add(rel);
      out.push(rel);
    }
  }
  return out;
}

interface ActiveTurnContext {
  readonly turnId: string;
  readonly workspaceRoot: string;
  readonly runtimeMode: ProviderTurnInput["runtimeMode"];
  readonly host: ProviderHost;
  readonly cancelController: AbortController;
  assistantText: string;
  toolCallsCount: number;
  permissionSeq: number;
  cancelled: boolean;
}

export interface AcpSessionRuntimeOptions {
  readonly threadId: string;
  readonly settings: AcpProviderSettings;
  readonly onOutboundFrame?: (frame: Record<string, unknown>) => void;
  readonly onInboundFrame?: (frame: Record<string, unknown>) => void;
}

/**
 * Manages a long-lived ACP v1 child process and session for a single `threadId`.
 * Modeled after `t3code`'s `AcpSessionRuntime`:
 * - Spawns once per thread and keeps the stdio JSON-RPC connection alive across turns
 * - Performs `initialize` -> optional `authenticate` -> `session/load` or `session/new`
 * - Streams `session/update` notifications and handles bidirectional `session/request_permission`,
 *   `fs/read_text_file`, and `fs/write_text_file` callbacks
 * - Cancels turns gracefully via `session/cancel` with a `cancelGraceMs` timeout before killing the process tree
 */
export class AcpSessionRuntime {
  public readonly threadId: string;
  private readonly settings: AcpProviderSettings;
  private readonly onOutboundFrame?: (frame: Record<string, unknown>) => void;
  private readonly onInboundFrame?: (frame: Record<string, unknown>) => void;

  private child?: ChildProcessWithoutNullStreams;
  private rpc?: AcpJsonRpcConnection;
  private initialized = false;
  private negotiatedVersion?: number;
  private agentCapabilities?: AcpAgentCapabilities;
  private authMethods: readonly AcpAuthMethod[] = [];
  private sessionId?: string;
  private sessionModes?: AcpSessionModeState | null;
  private activeTurn?: ActiveTurnContext;
  private defaultWorkspaceRoot?: string;
  private closed = false;

  constructor(options: AcpSessionRuntimeOptions) {
    this.threadId = options.threadId;
    this.settings = options.settings;
    this.onOutboundFrame = options.onOutboundFrame;
    this.onInboundFrame = options.onInboundFrame;
  }

  public getPid(): number | undefined {
    return this.child?.pid;
  }

  public getSessionId(): string | undefined {
    return this.sessionId;
  }

  public getNegotiatedProtocolVersion(): number | undefined {
    return this.negotiatedVersion;
  }

  public getAgentCapabilities(): AcpAgentCapabilities | undefined {
    return this.agentCapabilities;
  }

  public getSessionModes(): AcpSessionModeState | null | undefined {
    return this.sessionModes;
  }

  public isAlive(): boolean {
    return (
      !this.closed &&
      this.child !== undefined &&
      this.child.exitCode === null &&
      !this.child.killed &&
      this.rpc !== undefined &&
      !this.rpc.isClosed()
    );
  }

  private ensureProcessSpawned(input: ProviderTurnInput, host: ProviderHost): AcpJsonRpcConnection {
    if (this.isAlive() && this.rpc) {
      return this.rpc;
    }

    const cwd =
      this.settings.config.cwd ??
      this.settings.config.workingDirectoryOverride ??
      input.workspaceRoot;
    this.defaultWorkspaceRoot = input.workspaceRoot;

    const mcpEndpoint = host.getThreadMcpEndpoint?.(input.threadId, input.runtimeMode);

    // Combine ambient process.env with configured env BEFORE sanitization so no cloud keys leak
    const mergedRawEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.settings.config.env
    };

    const sanitizedEnv = sanitizeSubprocessEnv(mergedRawEnv, {
      caBundlePath: this.settings.caBundlePath,
      overrides: {
        CONDUCTOR_OFFLINE_MODE: "1",
        CONDUCTOR_ACP_MODEL: input.model,
        CONDUCTOR_MODE_LIMIT: input.runtimeMode,
        ...(mcpEndpoint ? { CONDUCTOR_MCP_URL: mcpEndpoint.url } : {})
      }
    });

    const child = spawn(this.settings.config.command, this.settings.config.args, {
      cwd,
      env: sanitizedEnv,
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.child = child;
    this.initialized = false;
    this.sessionId = undefined;
    this.closed = false;

    const rpc = new AcpJsonRpcConnection({
      readable: child.stdout,
      writable: child.stdin,
      onOutboundFrame: this.onOutboundFrame,
      onInboundFrame: this.onInboundFrame
    });
    this.rpc = rpc;

    child.on("error", (err) => {
      rpc.close(err);
    });

    child.on("close", (code, signal) => {
      rpc.close(
        new Error(
          `ACP agent process exited (code=${String(code)}, signal=${String(signal)})`
        )
      );
    });

    this.registerClientHandlers(rpc);
    return rpc;
  }

  private registerClientHandlers(rpc: AcpJsonRpcConnection): void {
    // 1. session/update notification
    rpc.onNotification<AcpSessionNotification>(
      "session/update",
      (notif) => {
        this.handleSessionUpdate(notif);
      },
      AcpSessionNotificationSchema
    );

    // 2. session/request_permission request
    rpc.onRequest<AcpRequestPermissionRequest, AcpRequestPermissionResponse>(
      "session/request_permission",
      async (params) => {
        return await this.handleRequestPermission(params);
      },
      AcpRequestPermissionRequestSchema
    );

    // 3. fs/read_text_file request
    rpc.onRequest<AcpReadTextFileRequest, AcpReadTextFileResponse>(
      "fs/read_text_file",
      async (params) => {
        return await this.handleReadTextFile(params);
      },
      AcpReadTextFileRequestSchema
    );

    // 4. fs/write_text_file request
    rpc.onRequest<AcpWriteTextFileRequest, AcpWriteTextFileResponse>(
      "fs/write_text_file",
      async (params) => {
        return await this.handleWriteTextFile(params);
      },
      AcpWriteTextFileRequestSchema
    );
  }

  private handleSessionUpdate(notif: AcpSessionNotification): void {
    const turn = this.activeTurn;
    if (!turn) {
      return;
    }
    if (this.sessionId && notif.sessionId !== this.sessionId) {
      return;
    }

    const update = notif.update as Record<string, unknown>;
    const kind = String(update.sessionUpdate ?? "");

    switch (kind) {
      case "agent_message_chunk": {
        const content = update.content as { type?: string; text?: string } | undefined;
        if (content?.type === "text" && typeof content.text === "string") {
          turn.assistantText += content.text;
          turn.host.emitStreamEvent({
            streamId: this.threadId,
            type: "message.delta",
            payload: {
              threadId: this.threadId,
              turnId: turn.turnId,
              textDelta: content.text
            }
          });
        }
        break;
      }

      case "agent_thought_chunk": {
        const content = update.content as { type?: string; text?: string } | undefined;
        if (content?.type === "text" && typeof content.text === "string") {
          turn.host.emitStreamEvent({
            streamId: this.threadId,
            type: "reasoning.delta",
            payload: {
              threadId: this.threadId,
              turnId: turn.turnId,
              textDelta: content.text
            }
          });
        }
        break;
      }

      case "tool_call": {
        const toolCallId = String(update.toolCallId ?? `tc_${++turn.toolCallsCount}`);
        turn.toolCallsCount += 1;
        const title =
          typeof update.title === "string" && update.title.length > 0
            ? update.title
            : typeof update.kind === "string"
              ? update.kind
              : "acp_tool";
        turn.host.emitStreamEvent({
          streamId: this.threadId,
          type: "tool.call.started",
          payload: {
            threadId: this.threadId,
            turnId: turn.turnId,
            toolCallId,
            toolName: title,
            kind: update.kind ?? "other",
            status: update.status ?? "in_progress",
            args:
              typeof update.rawInput === "object" && update.rawInput !== null
                ? update.rawInput
                : { rawInput: update.rawInput }
          }
        });
        break;
      }

      case "tool_call_update": {
        const toolCallId = String(update.toolCallId ?? "");
        const status = typeof update.status === "string" ? update.status : "completed";
        if (status === "completed" || status === "failed") {
          turn.host.emitStreamEvent({
            streamId: this.threadId,
            type: "tool.call.completed",
            payload: {
              threadId: this.threadId,
              turnId: turn.turnId,
              toolCallId,
              status,
              result: update.rawOutput ?? update.content ?? {}
            }
          });
        }
        break;
      }

      case "plan": {
        const entries = Array.isArray(update.entries) ? update.entries : [];
        turn.host.emitStreamEvent({
          streamId: this.threadId,
          type: "plan.updated",
          payload: {
            threadId: this.threadId,
            turnId: turn.turnId,
            entries
          }
        });
        break;
      }

      default:
        // Unknown sessionUpdate kinds (e.g., available_commands_update, current_mode_update)
        // are ignored gracefully per ACP spec.
        break;
    }
  }

  private async handleRequestPermission(
    params: AcpRequestPermissionRequest
  ): Promise<AcpRequestPermissionResponse> {
    const turn = this.activeTurn;
    if (!turn || turn.cancelled || turn.cancelController.signal.aborted) {
      return {
        outcome: {
          outcome: "cancelled"
        }
      };
    }

    // In plan-only mode, reject mutating tool calls immediately without prompting the user
    const toolKind = String(params.toolCall.kind ?? "other");
    const isMutating =
      toolKind === "edit" ||
      toolKind === "delete" ||
      toolKind === "move" ||
      toolKind === "execute";
    if (turn.runtimeMode === "plan-only" && isMutating) {
      turn.host.recordAuditEvent?.(
        "agent.approval",
        `ACP permission rejected automatically in plan-only mode for '${params.toolCall.title ?? params.toolCall.toolCallId}'`,
        {
          sessionId: params.sessionId,
          toolCallId: params.toolCall.toolCallId,
          kind: toolKind,
          outcome: "rejected_plan_only"
        }
      );
      const rejectOpt = params.options.find(
        (o) => o.kind === "reject_once" || o.kind === "reject_always"
      );
      if (rejectOpt) {
        return {
          outcome: {
            outcome: "selected",
            optionId: rejectOpt.optionId
          }
        };
      }
      return {
        outcome: {
          outcome: "cancelled"
        }
      };
    }

    const requestId = `req_acp_${turn.turnId}_${++turn.permissionSeq}`;
    const question =
      params.toolCall.title ??
      `Agent ACP prosi o uprawnienie dla narzędzia '${params.toolCall.toolCallId}'`;

    try {
      const resolution = await turn.host.requestApproval(
        {
          requestId,
          threadId: this.threadId,
          turnId: turn.turnId,
          question,
          options: params.options.map((o) => ({
            id: o.optionId,
            label: o.name,
            kind: o.kind
          }))
        },
        turn.cancelController.signal
      );

      turn.host.recordAuditEvent?.(
        "agent.approval",
        `ACP permission resolved for '${question}' -> ${resolution.selectedOptionId}`,
        {
          sessionId: params.sessionId,
          toolCallId: params.toolCall.toolCallId,
          selectedOptionId: resolution.selectedOptionId
        }
      );

      return {
        outcome: {
          outcome: "selected",
          optionId: resolution.selectedOptionId
        }
      };
    } catch {
      turn.host.recordAuditEvent?.(
        "agent.approval",
        `ACP permission cancelled for '${question}'`,
        {
          sessionId: params.sessionId,
          toolCallId: params.toolCall.toolCallId,
          outcome: "cancelled"
        }
      );
      return {
        outcome: {
          outcome: "cancelled"
        }
      };
    }
  }

  private async handleReadTextFile(
    params: AcpReadTextFileRequest
  ): Promise<AcpReadTextFileResponse> {
    const workspaceRoot = this.activeTurn?.workspaceRoot ?? this.defaultWorkspaceRoot;
    if (!workspaceRoot) {
      throw new AcpJsonRpcError(JSONRPC_ERROR_INTERNAL, "No workspaceRoot bound to ACP session");
    }

    let safePath: string;
    try {
      safePath = resolveSafeWorkspacePath(workspaceRoot, params.path);
    } catch (err) {
      if (err instanceof PathTraversalError) {
        throw new AcpJsonRpcError(JSONRPC_ERROR_PERMISSION_DENIED, err.message);
      }
      throw err;
    }

    if (!existsSync(safePath)) {
      throw new AcpJsonRpcError(
        JSONRPC_ERROR_INTERNAL,
        `ENOENT: File not found in workspace: ${params.path}`
      );
    }

    const fullText = readFileSync(safePath, "utf8");
    if (params.line == null && params.limit == null) {
      return { content: fullText };
    }

    const lines = fullText.split(/\r?\n/);
    const startIdx = params.line ? Math.max(0, params.line - 1) : 0;
    const endIdx = params.limit ? startIdx + params.limit : lines.length;
    return {
      content: lines.slice(startIdx, endIdx).join("\n")
    };
  }

  private async handleWriteTextFile(
    params: AcpWriteTextFileRequest
  ): Promise<AcpWriteTextFileResponse> {
    const turn = this.activeTurn;
    const workspaceRoot = turn?.workspaceRoot ?? this.defaultWorkspaceRoot;
    if (!workspaceRoot) {
      throw new AcpJsonRpcError(JSONRPC_ERROR_INTERNAL, "No workspaceRoot bound to ACP session");
    }

    let safePath: string;
    try {
      safePath = resolveSafeWorkspacePath(workspaceRoot, params.path);
    } catch (err) {
      if (err instanceof PathTraversalError) {
        throw new AcpJsonRpcError(JSONRPC_ERROR_PERMISSION_DENIED, err.message);
      }
      throw err;
    }

    const runtimeMode = turn?.runtimeMode ?? "supervised";
    if (runtimeMode === "plan-only") {
      turn?.host.recordAuditEvent?.(
        "agent.file_edit",
        `Blocked ACP fs/write_text_file in plan-only mode: ${params.path}`,
        { path: params.path, runtimeMode, blocked: true }
      );
      throw new AcpJsonRpcError(
        JSONRPC_ERROR_PERMISSION_DENIED,
        `ERR_MODE_VIOLATION: fs/write_text_file is forbidden in plan-only mode (${params.path})`
      );
    }

    if (runtimeMode === "supervised" && turn) {
      const requestId = `req_acp_fs_${turn.turnId}_${++turn.permissionSeq}`;
      let resolution;
      try {
        resolution = await turn.host.requestApproval(
          {
            requestId,
            threadId: this.threadId,
            turnId: turn.turnId,
            question: `Agent ACP chce zapisać plik '${params.path}' (${params.content.length} B)`,
            options: [
              { id: "allow-once", label: "Zezwól raz", kind: "allow_once" },
              { id: "reject-once", label: "Odrzuć", kind: "reject_once" }
            ]
          },
          turn.cancelController.signal
        );
      } catch {
        throw new AcpJsonRpcError(
          JSONRPC_ERROR_PERMISSION_DENIED,
          `fs/write_text_file aborted while awaiting approval (${params.path})`
        );
      }

      if (
        resolution.selectedOptionId === "reject-once" ||
        resolution.selectedOptionId === "decline" ||
        resolution.selectedOptionId.startsWith("reject")
      ) {
        turn.host.recordAuditEvent?.(
          "agent.file_edit",
          `User rejected ACP fs/write_text_file: ${params.path}`,
          { path: params.path, selectedOptionId: resolution.selectedOptionId }
        );
        throw new AcpJsonRpcError(
          JSONRPC_ERROR_PERMISSION_DENIED,
          `ERR_PERMISSION_REJECTED: User rejected fs/write_text_file for ${params.path}`
        );
      }
    }

    mkdirSync(dirname(safePath), { recursive: true });
    writeFileSync(safePath, params.content, "utf8");

    turn?.host.recordAuditEvent?.(
      "agent.file_edit",
      `ACP fs/write_text_file wrote ${params.path} (${params.content.length} B)`,
      {
        sessionId: params.sessionId,
        path: params.path,
        bytesWritten: Buffer.byteLength(params.content, "utf8")
      }
    );

    return {};
  }

  private async buildMcpServersList(
    input: ProviderTurnInput,
    host: ProviderHost
  ): Promise<AcpMcpServer[]> {
    const endpoint = host.getThreadMcpEndpoint?.(input.threadId, input.runtimeMode);
    if (!endpoint) {
      return [];
    }

    await host.verifyOutboundUrl(endpoint.url);

    if (this.agentCapabilities?.mcpCapabilities?.http === true) {
      return [
        {
          type: "http",
          name: "conductor",
          url: endpoint.url,
          headers: Object.entries(endpoint.headers).map(([name, value]) => ({
            name,
            value
          }))
        }
      ];
    }

    return [
      {
        name: "conductor",
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
        env: [
          { name: "CONDUCTOR_MCP_URL", value: endpoint.url },
          ...Object.entries(endpoint.headers).map(([name, value]) => ({
            name: `CONDUCTOR_HEADER_${name.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase()}`,
            value
          }))
        ]
      }
    ];
  }

  private async ensureSessionInitialized(
    rpc: AcpJsonRpcConnection,
    input: ProviderTurnInput,
    host: ProviderHost,
    signal: AbortSignal
  ): Promise<{ readonly sessionId: string; readonly usedFallbackHistory: boolean }> {
    const initTimeoutMs = this.settings.config.initializeTimeoutMs ?? 10000;

    if (!this.initialized) {
      const initRes = await rpc.sendRequest(
        "initialize",
        {
          protocolVersion: ACP_LATEST_PROTOCOL_VERSION,
          clientCapabilities: {
            fs: {
              readTextFile: true,
              writeTextFile: true
            }
          },
          clientInfo: {
            name: "conductor",
            title: "Conductor Air-Gapped Control Surface",
            version: "0.1.0"
          }
        },
        {
          requestSchema: AcpInitializeRequestSchema,
          responseSchema: AcpInitializeResponseSchema,
          timeoutMs: initTimeoutMs,
          signal
        }
      );

      this.negotiatedVersion = initRes.protocolVersion;
      this.agentCapabilities = initRes.agentCapabilities;
      this.authMethods = initRes.authMethods ?? [];
      this.initialized = true;

      if (this.settings.config.authMethodId) {
        await rpc.sendRequest(
          "authenticate",
          {
            methodId: this.settings.config.authMethodId
          },
          {
            requestSchema: AcpAuthenticateRequestSchema,
            responseSchema: AcpAuthenticateResponseSchema,
            timeoutMs: initTimeoutMs,
            signal
          }
        );
      }
    }

    if (this.sessionId) {
      await this.syncSessionModeIfNeeded(rpc, this.sessionId, input.runtimeMode, initTimeoutMs, signal);
      return { sessionId: this.sessionId, usedFallbackHistory: false };
    }

    const cwd =
      this.settings.config.cwd ??
      this.settings.config.workingDirectoryOverride ??
      input.workspaceRoot;
    const mcpServers = await this.buildMcpServersList(input, host);

    // If thread has a persisted acpSessionId and agent supports loadSession, resume it via session/load
    if (input.acpSessionId && this.agentCapabilities?.loadSession === true) {
      const loadRes = await rpc.sendRequest(
        "session/load",
        {
          sessionId: input.acpSessionId,
          cwd,
          mcpServers
        },
        {
          requestSchema: AcpLoadSessionRequestSchema,
          responseSchema: AcpLoadSessionResponseSchema,
          timeoutMs: initTimeoutMs,
          signal
        }
      );
      this.sessionId = input.acpSessionId;
      this.sessionModes = loadRes.modes;
      await this.syncSessionModeIfNeeded(rpc, this.sessionId, input.runtimeMode, initTimeoutMs, signal);
      return { sessionId: this.sessionId, usedFallbackHistory: false };
    }

    // Otherwise create a new ACP session via session/new
    let newRes;
    try {
      newRes = await rpc.sendRequest(
        "session/new",
        {
          cwd,
          mcpServers
        },
        {
          requestSchema: AcpNewSessionRequestSchema,
          responseSchema: AcpNewSessionResponseSchema,
          timeoutMs: initTimeoutMs,
          signal
        }
      );
    } catch (err) {
      if (this.authMethods.length > 0 && !this.settings.config.authMethodId) {
        const methodList = this.authMethods.map((m) => m.id).join(", ");
        throw new Error(
          `ERR_ACP_AUTH_REQUIRED: Agent ACP wymaga uwierzytelnienia (dostępne metody: ${methodList}). Skonfiguruj authMethodId w ustawieniach instancji.`
        );
      }
      throw err;
    }

    this.sessionId = newRes.sessionId;
    this.sessionModes = newRes.modes;
    host.persistThreadSessionId?.(input.threadId, newRes.sessionId);

    await this.syncSessionModeIfNeeded(rpc, this.sessionId, input.runtimeMode, initTimeoutMs, signal);

    const usedFallbackHistory = Boolean(input.history && input.history.length > 0);
    return { sessionId: this.sessionId, usedFallbackHistory };
  }

  private async syncSessionModeIfNeeded(
    rpc: AcpJsonRpcConnection,
    sessionId: string,
    runtimeMode: ProviderTurnInput["runtimeMode"],
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<void> {
    if (!this.sessionModes || this.sessionModes.availableModes.length === 0) {
      return;
    }
    const available = this.sessionModes.availableModes;
    const findMatch = (): string | undefined => {
      for (const m of available) {
        const idLower = m.id.toLowerCase();
        if (runtimeMode === "plan-only" && (idLower === "plan" || idLower === "plan-only" || idLower === "architect")) {
          return m.id;
        }
        if (runtimeMode === "supervised" && (idLower === "supervised" || idLower === "default" || idLower === "ask" || idLower === "code")) {
          return m.id;
        }
        if (
          runtimeMode === "autonomous-sandbox" &&
          (idLower === "autonomous-sandbox" || idLower === "auto" || idLower === "autonomous")
        ) {
          return m.id;
        }
      }
      return undefined;
    };

    const targetModeId = findMatch();
    if (targetModeId && targetModeId !== this.sessionModes.currentModeId) {
      await rpc.sendRequest(
        "session/set_mode",
        {
          sessionId,
          modeId: targetModeId
        },
        {
          requestSchema: AcpSetSessionModeRequestSchema,
          responseSchema: AcpSetSessionModeResponseSchema,
          timeoutMs,
          signal
        }
      );
      this.sessionModes = {
        ...this.sessionModes,
        currentModeId: targetModeId
      };
    }
  }

  private buildPromptContentBlocks(
    input: ProviderTurnInput,
    includeFallbackHistory: boolean
  ): AcpContentBlock[] {
    const blocks: AcpContentBlock[] = [];

    if (includeFallbackHistory && input.history && input.history.length > 0) {
      const formattedHistory = input.history
        .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
        .join("\n\n");
      blocks.push({
        type: "text",
        text: `[Prior Conversation Context]\n${formattedHistory}`
      });
    }

    const fileRefs = extractFileRefsFromPrompt(input.prompt);
    for (const relPath of fileRefs) {
      try {
        const safePath = resolveSafeWorkspacePath(input.workspaceRoot, relPath);
        if (existsSync(safePath)) {
          const fileUri = pathToFileURL(safePath).href;
          if (this.agentCapabilities?.promptCapabilities?.embeddedContext === true) {
            blocks.push({
              type: "resource",
              resource: {
                uri: fileUri,
                text: readFileSync(safePath, "utf8")
              }
            });
          } else {
            blocks.push({
              type: "resource_link",
              uri: fileUri,
              name: relPath
            });
          }
        }
      } catch {
        // Ignore invalid @file references outside workspace
      }
    }

    blocks.push({
      type: "text",
      text: input.prompt
    });

    return blocks;
  }

  public async runTurn(
    input: ProviderTurnInput,
    host: ProviderHost,
    signal: AbortSignal
  ): Promise<ProviderTurnOutcome> {
    if (signal.aborted) {
      return {
        status: "cancelled",
        assistantText: "",
        toolCallsCount: 0
      };
    }

    const cancelController = new AbortController();
    const turnCtx: ActiveTurnContext = {
      turnId: input.turnId,
      workspaceRoot: input.workspaceRoot,
      runtimeMode: input.runtimeMode,
      host,
      cancelController,
      assistantText: "",
      toolCallsCount: 0,
      permissionSeq: 0,
      cancelled: false
    };
    this.activeTurn = turnCtx;

    const onCallerAbort = () => {
      void this.cancelActiveTurn();
    };
    signal.addEventListener("abort", onCallerAbort, { once: true });

    try {
      const rpc = this.ensureProcessSpawned(input, host);
      const { sessionId, usedFallbackHistory } = await this.ensureSessionInitialized(
        rpc,
        input,
        host,
         cancelController.signal
      );

      const promptBlocks = this.buildPromptContentBlocks(input, usedFallbackHistory);

      // Note: Do NOT pass cancelController.signal to `session/prompt` sendRequest directly,
      // because on cancellation we must first send `session/cancel` notification and wait up to
      // `cancelGraceMs` for the agent's `{ stopReason: "cancelled" }` response!
      const promptRes = await rpc.sendRequest(
        "session/prompt",
        {
          sessionId,
          prompt: promptBlocks
        },
        {
          requestSchema: AcpPromptRequestSchema,
          responseSchema: AcpPromptResponseSchema
        }
      );

      if (promptRes.stopReason === "cancelled" || turnCtx.cancelled) {
        return {
          status: "cancelled",
          assistantText: turnCtx.assistantText,
          toolCallsCount: turnCtx.toolCallsCount
        };
      }

      if (promptRes.stopReason === "refusal") {
        return {
          status: "failed",
          assistantText: turnCtx.assistantText,
          toolCallsCount: turnCtx.toolCallsCount,
          errorMessage: "ACP agent refused the prompt (stopReason: refusal)"
        };
      }

      // "end_turn" | "max_tokens" | "max_turn_requests"
      return {
        status: "completed",
        assistantText: turnCtx.assistantText,
        toolCallsCount: turnCtx.toolCallsCount
      };
    } catch (err) {
      if (turnCtx.cancelled || signal.aborted) {
        return {
          status: "cancelled",
          assistantText: turnCtx.assistantText,
          toolCallsCount: turnCtx.toolCallsCount
        };
      }
      return {
        status: "failed",
        assistantText: turnCtx.assistantText,
        toolCallsCount: turnCtx.toolCallsCount,
        errorMessage: err instanceof Error ? err.message : String(err)
      };
    } finally {
      signal.removeEventListener("abort", onCallerAbort);
      if (this.activeTurn === turnCtx) {
        this.activeTurn = undefined;
      }
    }
  }

  /**
   * Cancels the currently active turn by sending `session/cancel` notification
   * and waiting up to `cancelGraceMs` for `session/prompt` to return `{ stopReason: "cancelled" }`.
   * Only kills the child process tree if the agent fails to respond within `cancelGraceMs`.
   */
  public async cancelActiveTurn(): Promise<void> {
    const turn = this.activeTurn;
    if (!turn || turn.cancelled) {
      return;
    }
    turn.cancelled = true;
    // Immediately abort any pending permission approval prompt so `session/request_permission`
    // replies with `{ outcome: { outcome: "cancelled" } }`.
    turn.cancelController.abort();

    if (this.rpc && !this.rpc.isClosed() && this.sessionId) {
      try {
        this.rpc.sendNotification(
          "session/cancel",
          { sessionId: this.sessionId },
          AcpCancelNotificationSchema
        );
      } catch {
        // Ignore write error if stream already closed
      }
    }

    const graceMs = this.settings.config.cancelGraceMs ?? 3000;
    const start = Date.now();
    while (this.activeTurn === turn && Date.now() - start < graceMs) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    // If the turn is still hanging after `cancelGraceMs`, force-kill the process tree
    if (this.activeTurn === turn) {
      await this.close();
    }
  }

  public async close(): Promise<void> {
    this.closed = true;
    if (this.activeTurn) {
      this.activeTurn.cancelled = true;
      this.activeTurn.cancelController.abort();
    }
    if (this.rpc) {
      this.rpc.close(new Error("ACP session runtime closed"));
      this.rpc = undefined;
    }
    if (this.child) {
      killProcessTree(this.child);
      this.child = undefined;
    }
    this.initialized = false;
    this.sessionId = undefined;
  }
}
