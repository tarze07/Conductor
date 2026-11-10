import http from "node:http";
import { URL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import {
  CLIENT_GUARDED_RPC_SCOPES,
  OrchestrationCommandSchema,
  RpcRequestEnvelopeSchema,
  RpcStreamSubscribeSchema,
  type GuardedRpcMethod,
  type RpcResponseEnvelope,
  type RpcScope,
  type RpcStreamEventEnvelope
} from "@conductor/contracts";
import { DEFAULT_INTRANET_CIDRS, isIpInCidrs } from "@conductor/network-guard";
import {
  AuthorizationDeniedError,
  type AuthenticatedSession,
  type EnvironmentAuthService
} from "../auth/EnvironmentAuth.js";
import type { CheckpointStore } from "../checkpointing/CheckpointStore.js";
import {
  OrchestrationRejectedError,
  type OrchestratorV2
} from "../orchestration-v2/Orchestrator.js";
import type { EventSink } from "../persistence/EventSink.js";
import type { ProjectionMaintenance } from "../persistence/ProjectionMaintenance.js";

export interface ConductorRpcServerOptions {
  readonly environmentId: string;
  readonly host?: string;
  readonly port?: number;
  readonly allowedPeerCidrs?: readonly string[];
  readonly sink: EventSink;
  readonly orchestrator: OrchestratorV2;
  readonly projectionMaintenance: ProjectionMaintenance;
  readonly auth: EnvironmentAuthService;
  readonly checkpointStore: CheckpointStore;
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-security-policy":
      "default-src 'self'; connect-src 'self' ws: wss:; font-src 'self' data:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval';"
  });
  res.end(payload);
}

/**
 * HTTP + WebSocket RPC Server for Conductor Environment.
 * Enforces:
 * 1. Peer IP check (only loopback and RFC 1918 / configured corporate intranet CIDRs).
 * 2. Short-lived WebSocket tickets (`?ticket=...`) on `/ws` upgrade.
 * 3. Per-RPC method scope checks (`CLIENT_GUARDED_RPC_SCOPES`).
 * 4. Snapshot-aware stream subscriptions (`thread.subscribe` with `cursorSeq`).
 */
export class ConductorRpcServer {
  private readonly options: ConductorRpcServerOptions;
  private readonly httpServer: http.Server;
  private readonly wss: WebSocketServer;
  private readonly allowedPeerCidrs: readonly string[];
  private readonly socketCleanups = new Set<() => void>();

  constructor(options: ConductorRpcServerOptions) {
    this.options = options;
    this.allowedPeerCidrs = options.allowedPeerCidrs ?? DEFAULT_INTRANET_CIDRS;

    this.httpServer = http.createServer((req, res) => {
      void this.handleHttpRequest(req, res);
    });

    this.wss = new WebSocketServer({ noServer: true });

    this.httpServer.on("upgrade", (req, socket, head) => {
      const peerIp = req.socket.remoteAddress ?? "";
      if (!this.isPeerAllowed(peerIp)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }

      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname !== "/ws") {
          socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
          socket.destroy();
          return;
        }

        const ticket = url.searchParams.get("ticket") ?? "";
        const dpopParam = url.searchParams.get("dpop");
        const dpopProof = dpopParam
          ? (JSON.parse(dpopParam) as { jkt: string; jti: string })
          : undefined;

        const session = this.options.auth.consumeWebSocketTicket({
          ticket,
          expectedRoute: "rpc",
          dpopProof
        });

        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.handleWebSocketConnection(ws, session);
        });
      } catch {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
      }
    });
  }

  public isPeerAllowed(peerIp: string): boolean {
    if (!peerIp) {
      return false;
    }
    return isIpInCidrs(peerIp, this.allowedPeerCidrs);
  }

  public async listen(port = this.options.port ?? 0, host = this.options.host ?? "127.0.0.1"): Promise<number> {
    await new Promise<void>((resolve) => {
      this.httpServer.listen(port, host, resolve);
    });
    const addr = this.httpServer.address();
    return typeof addr === "object" && addr ? addr.port : port;
  }

  public async close(): Promise<void> {
    for (const cleanup of this.socketCleanups) {
      cleanup();
    }
    this.socketCleanups.clear();

    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve());
    });
    this.httpServer.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.httpServer.close(() => resolve());
    });
  }

  private async handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const peerIp = req.socket.remoteAddress ?? "";
    if (!this.isPeerAllowed(peerIp)) {
      sendJson(res, 403, {
        error: "ERR_PEER_IP_FORBIDDEN",
        message: "Direct connection from non-intranet address is forbidden"
      });
      req.socket.destroy();
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/.well-known/conductor-environment") {
      sendJson(res, 200, {
        environmentId: this.options.environmentId,
        protocolVersion: 2,
        capabilities: ["threadPullRequests", "threadPullRequestLinking"],
        offlineMode: true
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/auth/exchange") {
      try {
        const body = await readJsonBody(req);
        const exchanged = this.options.auth.exchangePairingCode({
          rawPairingCode: String(body.pairingCode ?? ""),
          requestedScopes: Array.isArray(body.scopes) ? (body.scopes as string[]) : undefined,
          subject: typeof body.subject === "string" ? body.subject : undefined,
          dpopJkt: typeof body.dpopJkt === "string" ? body.dpopJkt : undefined
        });
        sendJson(res, 200, {
          accessToken: exchanged.rawAccessToken,
          sessionId: exchanged.session.sessionId,
          scopes: exchanged.session.scopes,
          permissions: exchanged.session.scopes,
          expiresAt: exchanged.session.expiresAt
        });
      } catch (error) {
        const code = error instanceof AuthorizationDeniedError ? error.code : "ERR_AUTH_EXCHANGE";
        sendJson(res, 401, {
          error: code,
          message: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/auth/ws-ticket") {
      try {
        const authHeader = req.headers.authorization ?? "";
        const token = authHeader.replace(/^(Bearer|DPoP)\s+/i, "").trim();
        const body = await readJsonBody(req);
        const route = body.route === "media" ? "media" : "rpc";
        const dpopHeader = req.headers["dpop"];
        const dpopProof =
          typeof dpopHeader === "string"
            ? (JSON.parse(dpopHeader) as { jkt: string; jti: string })
            : undefined;

        const issued = this.options.auth.issueWebSocketTicket({
          rawAccessToken: token,
          route,
          dpopProof
        });
        sendJson(res, 200, issued);
      } catch (error) {
        const code = error instanceof AuthorizationDeniedError ? error.code : "ERR_WS_TICKET";
        sendJson(res, 401, {
          error: code,
          message: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }

    sendJson(res, 404, { error: "ERR_NOT_FOUND", message: "Route not found" });
  }

  private handleWebSocketConnection(ws: WebSocket, session: AuthenticatedSession): void {
    const activeSubscriptions = new Map<string, () => void>();
    const cleanup = (): void => {
      for (const unsub of activeSubscriptions.values()) {
        unsub();
      }
      activeSubscriptions.clear();
      try {
        ws.close();
      } catch {
        // Ignore close errors
      }
    };
    this.socketCleanups.add(cleanup);

    ws.on("close", () => {
      this.socketCleanups.delete(cleanup);
      for (const unsub of activeSubscriptions.values()) {
        unsub();
      }
      activeSubscriptions.clear();
    });

    ws.on("message", (rawData) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(rawData));
      } catch {
        return;
      }

      const subParse = RpcStreamSubscribeSchema.safeParse(parsed);
      if (subParse.success) {
        const sub = subParse.data;
        try {
          this.options.auth.authorizeRpcMethod(session, "thread.subscribe");
          const resume = this.options.projectionMaintenance.resumeThreadStream(
            sub.streamId,
            sub.cursorSeq
          );
          const initialFrame: RpcStreamEventEnvelope = {
            frameType: "rpc.stream.event",
            subscriptionId: sub.subscriptionId,
            streamId: sub.streamId,
            snapshot: resume.snapshot,
            events: [...resume.events]
          };
          ws.send(JSON.stringify(initialFrame));

          const unsub = this.options.sink.subscribe(sub.streamId, (liveEvents) => {
            const liveFrame: RpcStreamEventEnvelope = {
              frameType: "rpc.stream.event",
              subscriptionId: sub.subscriptionId,
              streamId: sub.streamId,
              events: [...liveEvents]
            };
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify(liveFrame));
            }
          });
          activeSubscriptions.set(sub.subscriptionId, unsub);
        } catch (error) {
          this.sendRpcError(ws, sub.subscriptionId, error);
        }
        return;
      }

      const reqParse = RpcRequestEnvelopeSchema.safeParse(parsed);
      if (!reqParse.success) {
        return;
      }

      const reqFrame = reqParse.data;
      try {
        if (!(reqFrame.method in CLIENT_GUARDED_RPC_SCOPES)) {
          throw new OrchestrationRejectedError(
            "ERR_UNKNOWN_RPC_METHOD",
            `Unknown RPC method '${reqFrame.method}'`
          );
        }

        const guardedMethod = reqFrame.method as GuardedRpcMethod;
        this.options.auth.authorizeRpcMethod(session, guardedMethod);
        const result = this.executeRpcMethod(session, guardedMethod, reqFrame.params);

        const response: RpcResponseEnvelope = {
          frameType: "rpc.response",
          requestId: reqFrame.requestId,
          ok: true,
          result
        };
        ws.send(JSON.stringify(response));
      } catch (error) {
        this.sendRpcError(ws, reqFrame.requestId, error);
      }
    });
  }

  private executeRpcMethod(
    session: AuthenticatedSession,
    method: GuardedRpcMethod,
    params: unknown
  ): unknown {
    switch (method) {
      case "environment.describe":
        return {
          environmentId: this.options.environmentId,
          protocolVersion: 2,
          capabilities: ["threadPullRequests", "threadPullRequestLinking"],
          offlineMode: true
        };

      case "project.list":
        return this.options.sink.listProjects();

      case "thread.list": {
        const p = (params ?? {}) as { projectId?: string };
        return this.options.sink.listThreads(p.projectId);
      }

      case "thread.get": {
        const p = (params ?? {}) as { threadId?: string };
        return this.options.sink.getThread(String(p.threadId ?? ""));
      }

      case "checkpoint.diff": {
        const p = params as { repoPath: string; fromRef: string; toRef: string };
        return this.options.checkpointStore.diffCheckpoints(p.repoPath, p.fromRef, p.toRef);
      }

      case "access.createPairing": {
        const p = params as {
          label: string;
          delegatedScopes: RpcScope[];
        };
        return this.options.auth.createDelegatedPairingGrant({
          callerSession: session,
          label: p.label,
          delegatedScopes: p.delegatedScopes
        });
      }

      case "project.register":
      case "thread.create":
      case "thread.auto-settle":
      case "turn.start":
      case "turn.cancel":
      case "checkpoint.restore":
      case "runtime-request.respond": {
        const command = OrchestrationCommandSchema.parse(params);
        return this.options.orchestrator.dispatch(command);
      }

      default:
        throw new OrchestrationRejectedError(
          "ERR_UNIMPLEMENTED_METHOD",
          `Method '${method}' is not implemented on this handler`
        );
    }
  }

  private sendRpcError(ws: WebSocket, requestId: string, error: unknown): void {
    if (error instanceof AuthorizationDeniedError) {
      const response: RpcResponseEnvelope = {
        frameType: "rpc.response",
        requestId,
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          requiredScope: error.requiredScope,
          requiredPermission: error.requiredPermission
        }
      };
      ws.send(JSON.stringify(response));
      return;
    }

    const code =
      error instanceof OrchestrationRejectedError ? error.code : "ERR_INTERNAL_RPC_FAILURE";
    const response: RpcResponseEnvelope = {
      frameType: "rpc.response",
      requestId,
      ok: false,
      error: {
        code,
        message: error instanceof Error ? error.message : String(error)
      }
    };
    ws.send(JSON.stringify(response));
  }
}
