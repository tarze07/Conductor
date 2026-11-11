import { randomUUID } from "node:crypto";
import { narrowModeCeiling } from "@conductor/agent-core";
import {
  DEFAULT_MODEL_SENTINEL,
  type RuntimeMode,
  type ThreadProjection
} from "@conductor/contracts";
import { NetworkPolicyEvaluator } from "@conductor/network-guard";
import type { EnvironmentAuthService } from "../auth/EnvironmentAuth.js";
import type { EffectWorker } from "../orchestration-v2/EffectWorker.js";
import type { OrchestratorV2 } from "../orchestration-v2/Orchestrator.js";
import type { EventSink } from "../persistence/EventSink.js";

export interface PeerLinkDelegationRequest {
  readonly sourceEnvironmentId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly title: string;
  readonly prompt: string;
  readonly providerInstanceId: string;
  readonly model?: string;
  readonly callerRuntimeMode: RuntimeMode;
}

export interface PeerLinkDelegationResult {
  readonly remoteEnvironmentId: string;
  readonly thread: ThreadProjection;
  readonly effectiveModeCeiling: RuntimeMode;
}

/**
 * Modeled after t3code's `PeerLinks` (`docs/internals/remote.md` — "Environment Linking"):
 * Connects two Conductor servers in a corporate LAN (e.g. a developer laptop and a shared
 * LAN GPU/build server) over `/mcp` (`conductor-peer-link`).
 *
 * Security Invariant:
 * Every forwarded call carries the calling agent's mode in `T3-Mode-Limit`, which the
 * receiving server only ever narrows the link's approved access with (`narrowModeCeiling`).
 * A `plan-only` agent therefore cannot start `autonomous-sandbox` or mutating work through
 * a `full-access` link.
 */
export class PeerLinkService {
  private readonly environmentId: string;
  private readonly sink: EventSink;
  private readonly orchestrator: OrchestratorV2;
  private readonly effectWorker: EffectWorker;
  private readonly auth: EnvironmentAuthService;
  private readonly networkEvaluator: NetworkPolicyEvaluator;

  constructor(params: {
    readonly environmentId: string;
    readonly sink: EventSink;
    readonly orchestrator: OrchestratorV2;
    readonly effectWorker: EffectWorker;
    readonly auth: EnvironmentAuthService;
    readonly networkEvaluator?: NetworkPolicyEvaluator;
  }) {
    this.environmentId = params.environmentId;
    this.sink = params.sink;
    this.orchestrator = params.orchestrator;
    this.effectWorker = params.effectWorker;
    this.auth = params.auth;
    this.networkEvaluator = params.networkEvaluator ?? new NetworkPolicyEvaluator();
  }

  /**
   * Handles an inbound `/mcp` (`conductor-peer-link`) delegation call on the receiving environment.
   */
  public async handleInboundDelegation(params: {
    readonly rawAccessToken: string;
    readonly headerModeLimit?: RuntimeMode;
    readonly request: PeerLinkDelegationRequest;
  }): Promise<PeerLinkDelegationResult> {
    const session = this.auth.authenticateToken(params.rawAccessToken);
    const sessionCeiling = session.modeCeiling ?? "autonomous-sandbox";
    const effectiveMode = narrowModeCeiling(sessionCeiling, params.headerModeLimit);

    if (effectiveMode === "plan-only") {
      throw new Error(
        `[ERR_PEER_LINK_MODE_LIMIT] Inbound PeerLink delegation rejected: caller is fenced to 'plan-only' via T3-Mode-Limit`
      );
    }

    this.auth.authorizeRpcMethod(
      {
        ...session,
        modeCeiling: effectiveMode
      },
      "thread.create"
    );

    const now = new Date().toISOString();
    this.orchestrator.dispatch({
      commandId: `cmd_peer_thr_${params.request.threadId}_${randomUUID().slice(0, 8)}`,
      environmentId: this.environmentId,
      issuedAt: now,
      type: "thread.create",
      payload: {
        threadId: params.request.threadId,
        projectId: params.request.projectId,
        title: params.request.title,
        providerInstanceId: params.request.providerInstanceId,
        model: params.request.model ?? DEFAULT_MODEL_SENTINEL,
        runtimeMode: effectiveMode,
        linkOrigin: {
          sourceEnvironmentId: params.request.sourceEnvironmentId,
          modeCeiling: effectiveMode
        }
      }
    });

    this.orchestrator.dispatch({
      commandId: `cmd_peer_turn_${params.request.turnId}_${randomUUID().slice(0, 8)}`,
      environmentId: this.environmentId,
      issuedAt: new Date(Date.now() + 1).toISOString(),
      type: "turn.start",
      payload: {
        threadId: params.request.threadId,
        turnId: params.request.turnId,
        prompt: params.request.prompt,
        attachmentIds: []
      }
    });

    await this.effectWorker.drain();

    const thread = this.sink.getThread(params.request.threadId);
    if (!thread) {
      throw new Error(`Delegated thread '${params.request.threadId}' was not created`);
    }

    return {
      remoteEnvironmentId: this.environmentId,
      thread,
      effectiveModeCeiling: effectiveMode
    };
  }

  /**
   * Sends a delegated task from this environment (Environment A) to a linked LAN peer
   * environment (Environment B), automatically attaching the `T3-Mode-Limit` header.
   */
  public async delegateToRemotePeer(params: {
    readonly peerHttpBaseUrl: string;
    readonly peerAccessToken: string;
    readonly request: PeerLinkDelegationRequest;
  }): Promise<PeerLinkDelegationResult> {
    const baseUrl = params.peerHttpBaseUrl.replace(/\/+$/, "");
    const mcpUrl = `${baseUrl}/mcp/peer-link`;
    await this.networkEvaluator.verifyUrl(mcpUrl);

    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${params.peerAccessToken}`,
        "t3-mode-limit": params.request.callerRuntimeMode,
        "content-type": "application/json"
      },
      body: JSON.stringify(params.request)
    });

    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      throw new Error(
        `PeerLink delegation failed (${res.status}): ${errBody.message ?? errBody.error ?? "Rejected"}`
      );
    }

    return (await res.json()) as PeerLinkDelegationResult;
  }
}
