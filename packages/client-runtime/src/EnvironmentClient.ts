import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  PublicEnvironmentDescriptorSchema,
  type EnvironmentRoute,
  type GuardedRpcMethod,
  type OrchestrationEvent,
  type PublicEnvironmentDescriptor,
  type RpcResponseEnvelope,
  type RpcScope,
  type RpcStreamEventEnvelope,
  type ThreadProjection
} from "@conductor/contracts";

export class EnvironmentIdentityMismatchError extends Error {
  public readonly code = "ERR_ENVIRONMENT_IDENTITY_MISMATCH" as const;
  public readonly expectedEnvironmentId: string;
  public readonly actualEnvironmentId: string;
  public readonly routeUrl: string;

  constructor(params: {
    readonly expectedEnvironmentId: string;
    readonly actualEnvironmentId: string;
    readonly routeUrl: string;
  }) {
    super(
      `[ERR_ENVIRONMENT_IDENTITY_MISMATCH] Route '${params.routeUrl}' reported environmentId '${params.actualEnvironmentId}', expected '${params.expectedEnvironmentId}'. Refusing to transmit credentials.`
    );
    this.name = "EnvironmentIdentityMismatchError";
    this.expectedEnvironmentId = params.expectedEnvironmentId;
    this.actualEnvironmentId = params.actualEnvironmentId;
    this.routeUrl = params.routeUrl;
  }
}

export interface ThreadStreamClientState {
  readonly threadId: string;
  readonly snapshot?: ThreadProjection;
  readonly events: readonly OrchestrationEvent[];
  readonly cursorSeq: number;
}

export interface EnvironmentClientOptions {
  readonly expectedEnvironmentId?: string;
  readonly label?: string;
  readonly routes: readonly EnvironmentRoute[];
  readonly dpopJkt?: string;
  readonly routeProbeTimeoutMs?: number;
}

export interface VerifiedEnvironmentRoute {
  readonly route: EnvironmentRoute;
  readonly descriptor: PublicEnvironmentDescriptor;
}

/**
 * Shared client runtime for Web, Desktop, and CLI (modeled after t3code's `docs/internals/remote.md`).
 *
 * Security & Resilience Invariants:
 * 1. Always probes `/.well-known/conductor-environment` and verifies `environmentId` BEFORE
 *    transmitting any pairing code, bearer token, or DPoP proof.
 * 2. Evaluates ordered routes (LAN / loopback / tailnet) and fails over when a route is unreachable.
 * 3. Uses DPoP proof binding + single-use WebSocket tickets (`POST /auth/ws-ticket`) for `/ws`.
 * 4. Tracks per-thread `cursorSeq` so reconnections seamlessly resume from SQLite event streams
 *    or fall back to a projection snapshot if historical events were pruned.
 */
export class EnvironmentClient {
  private readonly options: EnvironmentClientOptions;
  private readonly dpopJkt: string;
  private activeRoute?: VerifiedEnvironmentRoute;
  private accessToken?: string;
  private grantedScopes: readonly RpcScope[] = [];
  private ws?: WebSocket;

  private readonly pendingRequests = new Map<
    string,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (reason: Error) => void;
    }
  >();

  private readonly threadSubscriptions = new Map<
    string,
    {
      readonly subscriptionId: string;
      readonly threadId: string;
      snapshot?: ThreadProjection;
      events: OrchestrationEvent[];
      cursorSeq: number;
      readonly listeners: Set<(state: ThreadStreamClientState) => void>;
    }
  >();

  constructor(options: EnvironmentClientOptions) {
    if (options.routes.length === 0) {
      throw new Error("EnvironmentClient requires at least one candidate route");
    }
    this.options = options;
    this.dpopJkt = options.dpopJkt ?? `jkt_${randomUUID().replace(/-/g, "")}`;
  }

  public getVerifiedDescriptor(): PublicEnvironmentDescriptor | undefined {
    return this.activeRoute?.descriptor;
  }

  public getActiveRoute(): EnvironmentRoute | undefined {
    return this.activeRoute?.route;
  }

  public getGrantedScopes(): readonly RpcScope[] {
    return this.grantedScopes;
  }

  /**
   * Probes candidate routes in order without sending any credentials.
   * Rejects immediately with `EnvironmentIdentityMismatchError` if a reachable route
   * reports a different `environmentId` than expected.
   */
  public async verifyAndSelectRoute(): Promise<VerifiedEnvironmentRoute> {
    const timeoutMs = this.options.routeProbeTimeoutMs ?? 2000;
    const connectionErrors: string[] = [];

    for (const route of this.options.routes) {
      const baseUrl = route.httpBaseUrl.replace(/\/$/, "");
      const descriptorUrl = `${baseUrl}/.well-known/conductor-environment`;

      let response: Response;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          response = await fetch(descriptorUrl, {
            method: "GET",
            signal: controller.signal
          });
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        connectionErrors.push(
          `${route.httpBaseUrl}: ${err instanceof Error ? err.message : String(err)}`
        );
        continue;
      }

      if (!response.ok) {
        connectionErrors.push(`${route.httpBaseUrl}: HTTP ${response.status}`);
        continue;
      }

      const rawJson = await response.json();
      const descriptor = PublicEnvironmentDescriptorSchema.parse(rawJson);

      if (
        this.options.expectedEnvironmentId &&
        descriptor.environmentId !== this.options.expectedEnvironmentId
      ) {
        throw new EnvironmentIdentityMismatchError({
          expectedEnvironmentId: this.options.expectedEnvironmentId,
          actualEnvironmentId: descriptor.environmentId,
          routeUrl: route.httpBaseUrl
        });
      }

      this.activeRoute = { route, descriptor };
      return this.activeRoute;
    }

    throw new Error(
      `All candidate routes failed for environment '${
        this.options.expectedEnvironmentId ?? "unknown"
      }': ${connectionErrors.join("; ")}`
    );
  }

  /**
   * Verifies the environment identity first, exchanges the one-time pairing code for a
   * DPoP-bound session token, and establishes the authenticated WebSocket connection.
   */
  public async connectWithPairingCode(params: {
    readonly pairingCode: string;
    readonly requestedScopes?: readonly RpcScope[];
    readonly subject?: string;
  }): Promise<PublicEnvironmentDescriptor> {
    const verified = await this.verifyAndSelectRoute();
    const baseUrl = verified.route.httpBaseUrl.replace(/\/$/, "");

    const exchangeRes = await fetch(`${baseUrl}/auth/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pairingCode: params.pairingCode,
        scopes: params.requestedScopes,
        subject: params.subject,
        dpopJkt: this.dpopJkt
      })
    });

    if (!exchangeRes.ok) {
      const errBody = (await exchangeRes.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      throw new Error(
        `Pairing exchange failed (${exchangeRes.status}): ${
          errBody.message ?? errBody.error ?? "Unauthorized"
        }`
      );
    }

    const exchanged = (await exchangeRes.json()) as {
      accessToken: string;
      scopes: RpcScope[];
    };

    this.accessToken = exchanged.accessToken;
    this.grantedScopes = exchanged.scopes;

    await this.openAuthenticatedWebSocket();
    return verified.descriptor;
  }

  /**
   * Reconnects using the already-exchanged DPoP access token, minting a fresh single-use
   * WebSocket ticket and resuming all active thread subscriptions from their saved `cursorSeq`.
   */
  public async reconnect(): Promise<void> {
    if (!this.accessToken) {
      throw new Error("Cannot reconnect: no active accessToken available");
    }
    await this.verifyAndSelectRoute();
    await this.openAuthenticatedWebSocket();

    // Re-subscribe all tracked threads using their latest cursorSeq
    for (const sub of this.threadSubscriptions.values()) {
      this.sendSubscribeFrame(sub.subscriptionId, sub.threadId, sub.cursorSeq);
    }
  }

  private async openAuthenticatedWebSocket(): Promise<void> {
    if (!this.activeRoute || !this.accessToken) {
      throw new Error("Route and accessToken must be initialized before opening WebSocket");
    }

    const httpBase = this.activeRoute.route.httpBaseUrl.replace(/\/$/, "");
    const wsBase = this.activeRoute.route.wsBaseUrl.replace(/\/$/, "");

    const ticketJti = `jti_ticket_${randomUUID()}`;
    const ticketRes = await fetch(`${httpBase}/auth/ws-ticket`, {
      method: "POST",
      headers: {
        authorization: `DPoP ${this.accessToken}`,
        dpop: JSON.stringify({ jkt: this.dpopJkt, jti: ticketJti }),
        "content-type": "application/json"
      },
      body: JSON.stringify({ route: "rpc" })
    });

    if (!ticketRes.ok) {
      throw new Error(`Failed to mint WebSocket ticket (HTTP ${ticketRes.status})`);
    }

    const { ticket } = (await ticketRes.json()) as { ticket: string };
    const upgradeJti = `jti_ws_${randomUUID()}`;
    const dpopQuery = encodeURIComponent(
      JSON.stringify({ jkt: this.dpopJkt, jti: upgradeJti })
    );

    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore close errors on stale socket
      }
    }

    const wsUrl = `${wsBase}/ws?ticket=${encodeURIComponent(ticket)}&dpop=${dpopQuery}`;
    const socket = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", (err) => reject(err));
    });

    socket.on("message", (rawData) => {
      this.handleIncomingFrame(String(rawData));
    });

    this.ws = socket;
  }

  private handleIncomingFrame(rawText: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      return;
    }

    if (parsed.frameType === "rpc.response") {
      const resp = parsed as unknown as RpcResponseEnvelope;
      const pending = this.pendingRequests.get(resp.requestId);
      if (!pending) {
        return;
      }
      this.pendingRequests.delete(resp.requestId);
      if (resp.ok) {
        pending.resolve(resp.result);
      } else {
        const err = new Error(resp.error?.message ?? "RPC request failed") as Error & {
          code?: string;
        };
        err.code = resp.error?.code;
        pending.reject(err);
      }
      return;
    }

    if (parsed.frameType === "rpc.stream.event") {
      const streamFrame = parsed as unknown as RpcStreamEventEnvelope;
      const sub = this.threadSubscriptions.get(streamFrame.streamId);
      if (!sub) {
        return;
      }

      if (streamFrame.snapshot) {
        sub.snapshot = streamFrame.snapshot;
        sub.cursorSeq = Math.max(sub.cursorSeq, streamFrame.snapshot.lastEventSeq);
      }

      for (const ev of streamFrame.events) {
        if (ev.seq > sub.cursorSeq || !sub.events.some((existing) => existing.seq === ev.seq)) {
          sub.events.push(ev);
        }
        if (ev.seq > sub.cursorSeq) {
          sub.cursorSeq = ev.seq;
        }
      }

      const snapshotState: ThreadStreamClientState = {
        threadId: sub.threadId,
        snapshot: sub.snapshot,
        events: [...sub.events],
        cursorSeq: sub.cursorSeq
      };

      for (const listener of sub.listeners) {
        listener(snapshotState);
      }
    }
  }

  public call<T = unknown>(method: GuardedRpcMethod, params?: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("WebSocket is not connected"));
    }

    const requestId = `req_${randomUUID()}`;
    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(requestId, {
        resolve: (val) => resolve(val as T),
        reject
      });

      this.ws!.send(
        JSON.stringify({
          frameType: "rpc.request",
          requestId,
          method,
          params
        })
      );
    });
  }

  public subscribeThread(
    threadId: string,
    listener: (state: ThreadStreamClientState) => void,
    initialCursorSeq = 0
  ): () => void {
    let sub = this.threadSubscriptions.get(threadId);
    if (!sub) {
      sub = {
        subscriptionId: `sub_${threadId}_${randomUUID().slice(0, 8)}`,
        threadId,
        events: [],
        cursorSeq: initialCursorSeq,
        listeners: new Set()
      };
      this.threadSubscriptions.set(threadId, sub);
      this.sendSubscribeFrame(sub.subscriptionId, threadId, sub.cursorSeq);
    }

    sub.listeners.add(listener);

    return () => {
      sub?.listeners.delete(listener);
      if (sub && sub.listeners.size === 0) {
        this.threadSubscriptions.delete(threadId);
      }
    };
  }

  public getThreadCursorSeq(threadId: string): number {
    return this.threadSubscriptions.get(threadId)?.cursorSeq ?? 0;
  }

  private sendSubscribeFrame(subscriptionId: string, streamId: string, cursorSeq: number): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(
      JSON.stringify({
        frameType: "rpc.subscribe",
        subscriptionId,
        streamId,
        cursorSeq
      })
    );
  }

  public async close(): Promise<void> {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error("EnvironmentClient closed"));
    }
    this.pendingRequests.clear();
    if (this.ws) {
      const socket = this.ws;
      this.ws = undefined;
      await new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        socket.once("close", () => resolve());
        socket.close();
      });
    }
  }
}
