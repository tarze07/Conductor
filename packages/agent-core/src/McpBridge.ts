import type { RuntimeMode } from "@conductor/contracts";
import type { AgentToolDefinition } from "./WorkspaceTools.js";

export type McpAccessLevel = "orchestration:read" | "orchestration:operate";

export interface McpRegisteredTool {
  readonly definition: AgentToolDefinition;
  readonly requiredAccess: McpAccessLevel;
  readonly handler: (
    args: Record<string, unknown>,
    callerContext: { readonly threadId: string; readonly effectiveMode: RuntimeMode }
  ) => Promise<Record<string, unknown>>;
}

const MODE_RANK: Readonly<Record<RuntimeMode, number>> = Object.freeze({
  "plan-only": 0,
  supervised: 1,
  "autonomous-sandbox": 2
});

/**
 * Narrows a session's runtime mode ceiling using the `T3-Mode-Limit` header
 * (matching t3code's `McpToolAccess.ts` and `remote.md`:
 * "Every forwarded call carries the calling agent's modes in `T3-Mode-Limit`, which
 * the receiving `/mcp` only ever narrows the client's approved access with.
 * A plan-mode agent therefore cannot start full-access work through a full-access link.")
 */
export function narrowModeCeiling(
  sessionCeiling: RuntimeMode,
  headerModeLimit?: RuntimeMode
): RuntimeMode {
  if (!headerModeLimit) {
    return sessionCeiling;
  }
  return MODE_RANK[headerModeLimit] < MODE_RANK[sessionCeiling]
    ? headerModeLimit
    : sessionCeiling;
}

/**
 * Thread-scoped MCP tool registry and access gate.
 * Every tool must declare `requiredAccess` (`orchestration:read` or `orchestration:operate`).
 */
export class ThreadMcpBridge {
  private readonly tools = new Map<string, McpRegisteredTool>();

  public registerTool(tool: McpRegisteredTool): void {
    this.tools.set(tool.definition.name, tool);
  }

  public listToolDefinitions(): readonly AgentToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }

  public async invokeTool(params: {
    readonly toolName: string;
    readonly args: Record<string, unknown>;
    readonly threadId: string;
    readonly grantedAccess: readonly McpAccessLevel[];
    readonly sessionCeiling: RuntimeMode;
    readonly headerModeLimit?: RuntimeMode;
  }): Promise<Record<string, unknown>> {
    const tool = this.tools.get(params.toolName);
    if (!tool) {
      throw new Error(`[ERR_MCP_TOOL_NOT_FOUND] Unknown MCP tool '${params.toolName}'`);
    }

    const effectiveMode = narrowModeCeiling(params.sessionCeiling, params.headerModeLimit);
    if (!params.grantedAccess.includes(tool.requiredAccess)) {
      throw new Error(
        `[ERR_MCP_ACCESS_DENIED] Caller lacks '${tool.requiredAccess}' for MCP tool '${params.toolName}'`
      );
    }

    if (effectiveMode === "plan-only" && tool.requiredAccess === "orchestration:operate") {
      throw new Error(
        `[ERR_MCP_MODE_CEILING] MCP operate tool '${params.toolName}' is denied under 'plan-only' T3-Mode-Limit`
      );
    }

    return tool.handler(params.args, {
      threadId: params.threadId,
      effectiveMode
    });
  }
}

export interface ExternalMcpEndpoint {
  readonly serverName: string;
  readonly listTools: () => Promise<readonly AgentToolDefinition[]>;
  readonly callTool: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

/**
 * Resilient MCP client wrapper that ensures an agent turn survives when an auxiliary
 * MCP server is unreachable (matching t3code's `adding-a-provider.md` requirement).
 */
export class ResilientMcpClient {
  private readonly endpoints: readonly ExternalMcpEndpoint[];

  constructor(endpoints: readonly ExternalMcpEndpoint[] = []) {
    this.endpoints = endpoints;
  }

  public async discoverToolsSafe(): Promise<readonly AgentToolDefinition[]> {
    const discovered: AgentToolDefinition[] = [];
    for (const ep of this.endpoints) {
      try {
        const tools = await ep.listTools();
        discovered.push(...tools);
      } catch {
        // Turn must survive when an MCP server is unreachable
      }
    }
    return discovered;
  }

  public async callToolSafe(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    for (const ep of this.endpoints) {
      try {
        const tools = await ep.listTools();
        if (tools.some((t) => t.name === toolName)) {
          return await ep.callTool(toolName, args);
        }
      } catch (error) {
        return {
          ok: false,
          mcpUnreachable: true,
          error: `MCP server '${ep.serverName}' is unreachable: ${
            error instanceof Error ? error.message : String(error)
          }`
        };
      }
    }
    return {
      ok: false,
      error: `Tool '${toolName}' not found on any connected MCP server`
    };
  }
}
