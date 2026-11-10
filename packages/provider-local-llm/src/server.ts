import {
  NativeAgentRuntime,
  type AgentConversationMessage,
  type AgentToolCall,
  type AgentToolDefinition,
  type LocalModelCompletionClient,
  type ModelGenerationStepResult
} from "@conductor/agent-core";
import { NetworkPolicyEvaluator } from "@conductor/network-guard";
import {
  resolveEffectiveModel,
  resolveSupportedRuntimeMode,
  type ProviderAdapterV2,
  type ProviderDriver,
  type ProviderHost,
  type ProviderStatusReport,
  type ProviderTurnInput,
  type ProviderTurnOutcome
} from "@conductor/provider-core/server";
import {
  LOCAL_LLM_PRESENTATION,
  type LocalLlmSettings
} from "./settings.js";

/**
 * Fallback parser for local models that emit structured `<tool_call>{...}</tool_call>` blocks
 * instead of native OpenAI/Anthropic `tool_calls`.
 */
export function parseFallbackToolCallsFromText(text: string): {
  readonly cleanedText: string;
  readonly toolCalls: readonly AgentToolCall[];
} {
  const toolCalls: AgentToolCall[] = [];
  const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let idx = 0;

  const cleanedText = text.replace(regex, (_fullMatch, innerJson: string) => {
    try {
      const parsed = JSON.parse(innerJson) as {
        id?: string;
        name?: string;
        arguments?: Record<string, unknown>;
      };
      if (typeof parsed.name === "string" && parsed.name.length > 0) {
        idx += 1;
        toolCalls.push({
          id: parsed.id ?? `fallback_tc_${idx}`,
          name: parsed.name,
          arguments: parsed.arguments ?? {}
        });
      }
    } catch {
      // Keep scanning if a block is malformed
    }
    return "";
  });

  return {
    cleanedText: cleanedText.trim(),
    toolCalls
  };
}

export class HttpLocalModelCompletionClient implements LocalModelCompletionClient {
  private readonly settings: LocalLlmSettings;
  private readonly networkEvaluator: NetworkPolicyEvaluator;

  constructor(settings: LocalLlmSettings, networkEvaluator?: NetworkPolicyEvaluator) {
    this.settings = settings;
    this.networkEvaluator =
      networkEvaluator ??
      new NetworkPolicyEvaluator({
        caBundlePath: settings.caBundlePath
      });
  }

  public async generateStep(params: {
    readonly model: string;
    readonly messages: readonly AgentConversationMessage[];
    readonly tools: readonly AgentToolDefinition[];
    readonly onTextDelta: (delta: string) => void;
    readonly signal: AbortSignal;
  }): Promise<ModelGenerationStepResult> {
    const baseUrl = (this.settings.baseUrl ?? "http://127.0.0.1:8000/v1").replace(/\/$/, "");
    const endpoint =
      this.settings.config.apiFormat === "anthropic-compatible"
        ? `${baseUrl}/messages`
        : `${baseUrl}/chat/completions`;

    // Strictly verify outbound URL against Zero-Internet policy before making the request
    await this.networkEvaluator.verifyUrl(endpoint);

    const requestBody =
      this.settings.config.apiFormat === "anthropic-compatible"
        ? {
            model: params.model,
            max_tokens: 4096,
            temperature: this.settings.config.temperature,
            messages: params.messages
              .filter((m) => m.role !== "system")
              .map((m) => ({
                role: m.role === "tool" ? "user" : m.role,
                content: m.content
              })),
            tools: params.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parametersJsonSchema
            }))
          }
        : {
            model: params.model,
            temperature: this.settings.config.temperature,
            stream: this.settings.config.stream,
            messages: params.messages.map((m) => {
              if (m.role === "tool") {
                return {
                  role: "tool",
                  tool_call_id: m.toolCallId,
                  name: m.toolName,
                  content: m.content
                };
              }
              if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
                return {
                  role: "assistant",
                  content: m.content,
                  tool_calls: m.toolCalls.map((tc) => ({
                    id: tc.id,
                    type: "function",
                    function: {
                      name: tc.name,
                      arguments: JSON.stringify(tc.arguments)
                    }
                  }))
                };
              }
              return { role: m.role, content: m.content };
            }),
            tools: params.tools.map((t) => ({
              type: "function",
              function: {
                name: t.name,
                description: t.description,
                parameters: t.parametersJsonSchema
              }
            }))
          };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(requestBody),
      signal: params.signal
    });

    if (response.status === 429) {
      const resetHeader =
        response.headers.get("x-ratelimit-reset") ??
        response.headers.get("retry-after") ??
        new Date(Date.now() + 60_000).toISOString();
      return {
        assistantText: "",
        toolCalls: [],
        usageLimitResetAt: resetHeader
      };
    }

    if (!response.ok) {
      throw new Error(`Local LLM endpoint returned HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      return this.consumeSseResponse(response, params.onTextDelta);
    }

    const json = (await response.json()) as Record<string, unknown>;
    return this.parseJsonResponse(json, params.onTextDelta);
  }

  private async consumeSseResponse(
    response: Response,
    onTextDelta: (delta: string) => void
  ): Promise<ModelGenerationStepResult> {
    const rawText = await response.text();
    let fullText = "";
    const toolCallsById = new Map<string, { id: string; name: string; argsRaw: string }>();

    const lines = rawText.split("\n");
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) {
        continue;
      }
      const dataStr = line.slice("data:".length).trim();
      if (!dataStr || dataStr === "[DONE]") {
        continue;
      }

      const chunk = JSON.parse(dataStr) as {
        choices?: Array<{
          delta?: {
            content?: string;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
      };

      const delta = chunk.choices?.[0]?.delta;
      if (!delta) {
        continue;
      }

      if (typeof delta.content === "string" && delta.content.length > 0) {
        fullText += delta.content;
        onTextDelta(delta.content);
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const key = tc.id ?? `idx_${tc.index ?? 0}`;
          const existing = toolCallsById.get(key) ?? {
            id: tc.id ?? `call_${tc.index ?? 0}`,
            name: "",
            argsRaw: ""
          };
          if (tc.function?.name) {
            existing.name += tc.function.name;
          }
          if (tc.function?.arguments) {
            existing.argsRaw += tc.function.arguments;
          }
          toolCallsById.set(key, existing);
        }
      }
    }

    const nativeToolCalls: AgentToolCall[] = [];
    for (const entry of toolCallsById.values()) {
      if (entry.name) {
        nativeToolCalls.push({
          id: entry.id,
          name: entry.name,
          arguments: entry.argsRaw ? (JSON.parse(entry.argsRaw) as Record<string, unknown>) : {}
        });
      }
    }

    if (nativeToolCalls.length > 0) {
      return {
        assistantText: fullText,
        toolCalls: nativeToolCalls
      };
    }

    const fallback = parseFallbackToolCallsFromText(fullText);
    return {
      assistantText: fallback.cleanedText,
      toolCalls: fallback.toolCalls
    };
  }

  private parseJsonResponse(
    json: Record<string, unknown>,
    onTextDelta: (delta: string) => void
  ): ModelGenerationStepResult {
    // Anthropic Messages API shape
    if (Array.isArray(json.content)) {
      let text = "";
      const toolCalls: AgentToolCall[] = [];
      for (const block of json.content as Array<Record<string, unknown>>) {
        if (block.type === "text" && typeof block.text === "string") {
          text += block.text;
          onTextDelta(block.text);
        } else if (block.type === "tool_use" && typeof block.name === "string") {
          toolCalls.push({
            id: String(block.id ?? `tu_${toolCalls.length + 1}`),
            name: block.name,
            arguments: (block.input as Record<string, unknown>) ?? {}
          });
        }
      }
      return { assistantText: text, toolCalls };
    }

    // OpenAI Chat Completions shape
    const choices = json.choices as
      | Array<{
          message?: {
            content?: string | null;
            tool_calls?: Array<{
              id: string;
              function: { name: string; arguments: string };
            }>;
          };
        }>
      | undefined;

    const msg = choices?.[0]?.message;
    const rawContent = typeof msg?.content === "string" ? msg.content : "";
    if (rawContent) {
      onTextDelta(rawContent);
    }

    if (Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) {
      const toolCalls: AgentToolCall[] = msg.tool_calls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments
          ? (JSON.parse(tc.function.arguments) as Record<string, unknown>)
          : {}
      }));
      return {
        assistantText: rawContent,
        toolCalls
      };
    }

    const fallback = parseFallbackToolCallsFromText(rawContent);
    return {
      assistantText: fallback.cleanedText,
      toolCalls: fallback.toolCalls
    };
  }
}

export class LocalLlmProviderAdapter implements ProviderAdapterV2<LocalLlmSettings> {
  public readonly instanceSettings: LocalLlmSettings;
  public readonly presentation = LOCAL_LLM_PRESENTATION;
  private readonly networkEvaluator: NetworkPolicyEvaluator;
  private readonly activeAbortControllers = new Map<string, AbortController>();

  constructor(
    instanceSettings: LocalLlmSettings,
    networkEvaluator?: NetworkPolicyEvaluator
  ) {
    this.instanceSettings = instanceSettings;
    this.networkEvaluator =
      networkEvaluator ??
      new NetworkPolicyEvaluator({
        caBundlePath: instanceSettings.caBundlePath
      });
  }

  /**
   * Lightweight status probe that checks `/v1/models` without opening an agent session,
   * starting MCP servers, or running hooks (matching t3code's `providers.md` rule).
   */
  public async probeStatus(): Promise<ProviderStatusReport> {
    const baseUrl = (this.instanceSettings.baseUrl ?? "http://127.0.0.1:8000/v1").replace(/\/$/, "");
    const modelsUrl = `${baseUrl}/models`;
    try {
      await this.networkEvaluator.verifyUrl(modelsUrl);
      const res = await fetch(modelsUrl, { method: "GET" });
      if (!res.ok) {
        return {
          instanceId: this.instanceSettings.instanceId,
          driverKind: "local-llm",
          healthy: false,
          availableModels: [],
          detail: `HTTP ${res.status}`
        };
      }
      const data = (await res.json()) as { data?: Array<{ id: string }> };
      const models = Array.isArray(data.data) ? data.data.map((m) => m.id) : [];
      return {
        instanceId: this.instanceSettings.instanceId,
        driverKind: "local-llm",
        healthy: true,
        availableModels: models
      };
    } catch (error) {
      return {
        instanceId: this.instanceSettings.instanceId,
        driverKind: "local-llm",
        healthy: false,
        availableModels: [],
        detail: error instanceof Error ? error.message : String(error)
      };
    }
  }

  public async runTurn(
    input: ProviderTurnInput,
    host: ProviderHost,
    signal: AbortSignal
  ): Promise<ProviderTurnOutcome> {
    const effectiveModel = resolveEffectiveModel(
      input.model,
      this.instanceSettings,
      "qwen3-coder-30b"
    );
    const effectiveMode = resolveSupportedRuntimeMode(input.runtimeMode, this.presentation);

    const turnKey = `${input.threadId}:${input.turnId}`;
    const internalAbort = new AbortController();
    this.activeAbortControllers.set(turnKey, internalAbort);

    const onExternalAbort = () => internalAbort.abort();
    signal.addEventListener("abort", onExternalAbort, { once: true });

    try {
      const client = new HttpLocalModelCompletionClient(
        this.instanceSettings,
        this.networkEvaluator
      );
      const runtime = new NativeAgentRuntime(client, {
        maxSteps: this.instanceSettings.config.maxSteps
      });

      return await runtime.executeTurn(
        {
          ...input,
          model: effectiveModel,
          runtimeMode: effectiveMode
        },
        host,
        internalAbort.signal
      );
    } finally {
      signal.removeEventListener("abort", onExternalAbort);
      this.activeAbortControllers.delete(turnKey);
    }
  }

  public async cancelTurn(threadId: string, turnId: string): Promise<void> {
    const controller = this.activeAbortControllers.get(`${threadId}:${turnId}`);
    controller?.abort();
  }
}

export const localLlmProviderDriver: ProviderDriver<LocalLlmSettings> = {
  driverKind: "local-llm",
  presentation: LOCAL_LLM_PRESENTATION,
  fallbackDefaultModel: "qwen3-coder-30b",
  createAdapter(settings) {
    return new LocalLlmProviderAdapter(settings);
  }
};
