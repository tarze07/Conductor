import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  CLIENT_GUARDED_RPC_SCOPES,
  DEFAULT_MODEL_SENTINEL,
  OrchestrationCommandSchema,
  RpcRequestEnvelopeSchema,
  hasRequiredRpcScope,
  makeProviderSettingsSchema
} from "./index.js";

describe("@conductor/contracts permissions and RPC scope guards", () => {
  it("enforces required scope per guarded RPC method and honors plan-only mode ceiling", () => {
    expect(CLIENT_GUARDED_RPC_SCOPES["turn.start"]).toBe("orchestration:operate");
    expect(CLIENT_GUARDED_RPC_SCOPES["terminal.open"]).toBe("terminal:operate");

    expect(hasRequiredRpcScope(["orchestration:read"], "turn.start")).toBe(false);
    expect(hasRequiredRpcScope(["orchestration:operate"], "turn.start")).toBe(true);

    // Plan-only ceiling blocks terminal:operate even if session has terminal:operate scope
    expect(hasRequiredRpcScope(["terminal:operate"], "terminal.open", "plan-only")).toBe(false);
    expect(hasRequiredRpcScope(["terminal:operate"], "terminal.open", "supervised")).toBe(true);
  });
});

describe("@conductor/contracts provider settings schema factory", () => {
  it("creates typed provider settings schema with default model sentinel", () => {
    const LocalVllmSettingsSchema = makeProviderSettingsSchema("local-llm", {
      apiFormat: z.enum(["openai-compatible", "anthropic-compatible"]).default("openai-compatible"),
      maxContextTokens: z.number().int().positive().default(32768)
    });

    const parsed = LocalVllmSettingsSchema.parse({
      instanceId: "corp-vllm-1",
      driverKind: "local-llm",
      label: "Corporate vLLM Cluster (Qwen3-Coder)",
      baseUrl: "https://vllm.corp.internal:8000/v1",
      config: {}
    });

    expect(parsed.enabled).toBe(true);
    expect(parsed.defaultModel).toBe(DEFAULT_MODEL_SENTINEL);
    expect(parsed.config.apiFormat).toBe("openai-compatible");
    expect(parsed.config.maxContextTokens).toBe(32768);
  });
});

describe("@conductor/contracts orchestration commands and RPC frames", () => {
  it("validates discriminated union of orchestration commands and RPC envelopes", () => {
    const cmd = OrchestrationCommandSchema.parse({
      commandId: "cmd_01",
      environmentId: "env_local_01",
      issuedAt: "2026-11-10T10:00:00.000Z",
      type: "turn.start",
      payload: {
        threadId: "thr_01",
        turnId: "turn_01",
        prompt: "Dodaj obsługę offline cache"
      }
    });

    expect(cmd.type).toBe("turn.start");
    if (cmd.type === "turn.start") {
      expect(cmd.payload.attachmentIds).toEqual([]);
    }

    const rpcReq = RpcRequestEnvelopeSchema.parse({
      frameType: "rpc.request",
      requestId: "req_1",
      method: "turn.start",
      params: cmd
    });
    expect(rpcReq.method).toBe("turn.start");
  });
});
