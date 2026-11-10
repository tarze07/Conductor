import type {
  ProviderHost,
  ProviderTurnInput,
  ProviderTurnOutcome
} from "@conductor/provider-core";
import {
  BUILT_IN_AGENT_TOOLS,
  executeWorkspaceTool,
  type AgentToolCall,
  type AgentToolDefinition
} from "./WorkspaceTools.js";
import type { ResilientMcpClient } from "./McpBridge.js";

export type AgentConversationMessage =
  | { readonly role: "system" | "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly toolCalls?: readonly AgentToolCall[];
    }
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly content: string;
    };

export interface ModelGenerationStepResult {
  readonly assistantText: string;
  readonly toolCalls: readonly AgentToolCall[];
  readonly usageLimitResetAt?: string;
}

export interface LocalModelCompletionClient {
  generateStep(params: {
    readonly model: string;
    readonly messages: readonly AgentConversationMessage[];
    readonly tools: readonly AgentToolDefinition[];
    readonly onTextDelta: (delta: string) => void;
    readonly signal: AbortSignal;
  }): Promise<ModelGenerationStepResult>;
}

export interface NativeAgentRuntimeOptions {
  readonly maxSteps?: number;
  readonly mcpClient?: ResilientMcpClient;
}

/**
 * Built-in ReAct coding agent loop that runs entirely inside the corporate network
 * against any `LocalModelCompletionClient` (vLLM, Ollama, LiteLLM, TGI, llama.cpp).
 */
export class NativeAgentRuntime {
  private readonly modelClient: LocalModelCompletionClient;
  private readonly maxSteps: number;
  private readonly mcpClient?: ResilientMcpClient;

  constructor(
    modelClient: LocalModelCompletionClient,
    options: NativeAgentRuntimeOptions = {}
  ) {
    this.modelClient = modelClient;
    this.maxSteps = options.maxSteps ?? 12;
    this.mcpClient = options.mcpClient;
  }

  public async executeTurn(
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

    const extraMcpTools = this.mcpClient ? await this.mcpClient.discoverToolsSafe() : [];
    const availableTools: AgentToolDefinition[] =
      input.runtimeMode === "plan-only"
        ? [...BUILT_IN_AGENT_TOOLS.filter((t) => !t.mutatesState), ...extraMcpTools.filter((t) => !t.mutatesState)]
        : [...BUILT_IN_AGENT_TOOLS, ...extraMcpTools];

    const messages: AgentConversationMessage[] = [
      {
        role: "system",
        content:
          "You are Conductor, an offline-first enterprise coding agent operating inside an intranet workspace."
      },
      ...(input.history ?? []),
      {
        role: "user",
        content: input.prompt
      }
    ];

    const sessionApprovedCommands = new Set<string>();
    let cumulativeAssistantText = "";
    let totalToolCalls = 0;

    for (let step = 0; step < this.maxSteps; step += 1) {
      if (signal.aborted) {
        return {
          status: "cancelled",
          assistantText: cumulativeAssistantText,
          toolCallsCount: totalToolCalls
        };
      }

      const stepResult = await this.modelClient.generateStep({
        model: input.model,
        messages,
        tools: availableTools,
        onTextDelta: (delta) => {
          cumulativeAssistantText += delta;
          host.emitStreamEvent({
            streamId: input.threadId,
            type: "message.delta",
            payload: {
              threadId: input.threadId,
              turnId: input.turnId,
              textDelta: delta
            }
          });
        },
        signal
      });

      if (stepResult.usageLimitResetAt) {
        return {
          status: "usage_limit",
          assistantText: cumulativeAssistantText,
          toolCallsCount: totalToolCalls,
          errorMessage: "Local LLM cluster rate/capacity limit reached",
          usageLimitResetAt: stepResult.usageLimitResetAt
        };
      }

      messages.push({
        role: "assistant",
        content: stepResult.assistantText,
        toolCalls: stepResult.toolCalls
      });

      if (stepResult.toolCalls.length === 0) {
        return {
          status: "completed",
          assistantText: cumulativeAssistantText,
          toolCallsCount: totalToolCalls
        };
      }

      for (const call of stepResult.toolCalls) {
        if (signal.aborted) {
          return {
            status: "cancelled",
            assistantText: cumulativeAssistantText,
            toolCallsCount: totalToolCalls
          };
        }

        totalToolCalls += 1;
        host.emitStreamEvent({
          streamId: input.threadId,
          type: "tool.call.started",
          payload: {
            threadId: input.threadId,
            turnId: input.turnId,
            toolCallId: call.id,
            toolName: call.name,
            args: call.arguments
          }
        });

        const isBuiltIn = BUILT_IN_AGENT_TOOLS.some((t) => t.name === call.name);
        const toolResult = isBuiltIn
          ? await executeWorkspaceTool(call, {
              threadId: input.threadId,
              turnId: input.turnId,
              workspaceRoot: input.workspaceRoot,
              runtimeMode: input.runtimeMode,
              host,
              signal,
              sessionApprovedCommands
            })
          : this.mcpClient
            ? await this.mcpClient.callToolSafe(call.name, call.arguments)
            : { ok: false, error: `Unknown tool '${call.name}'` };

        host.emitStreamEvent({
          streamId: input.threadId,
          type: "tool.call.completed",
          payload: {
            threadId: input.threadId,
            turnId: input.turnId,
            toolCallId: call.id,
            toolName: call.name,
            result: toolResult
          }
        });

        messages.push({
          role: "tool",
          toolCallId: call.id,
          toolName: call.name,
          content: JSON.stringify(toolResult)
        });
      }
    }

    return {
      status: "completed",
      assistantText: cumulativeAssistantText,
      toolCallsCount: totalToolCalls
    };
  }
}
