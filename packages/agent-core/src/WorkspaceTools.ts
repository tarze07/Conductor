import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { RuntimeMode } from "@conductor/contracts";
import { sanitizeSubprocessEnv } from "@conductor/network-guard";
import type { ProviderHost } from "@conductor/provider-core";

export interface AgentToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parametersJsonSchema: Record<string, unknown>;
  readonly mutatesState: boolean;
}

export interface AgentToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export interface AgentToolExecutionContext {
  readonly threadId: string;
  readonly turnId: string;
  readonly workspaceRoot: string;
  readonly runtimeMode: RuntimeMode;
  readonly host: ProviderHost;
  readonly signal: AbortSignal;
  readonly sessionApprovedCommands: Set<string>;
}

export class PathTraversalError extends Error {
  public readonly code = "ERR_WORKSPACE_BOUNDARY_VIOLATION" as const;

  constructor(requestedPath: string, workspaceRoot: string) {
    super(
      `[ERR_WORKSPACE_BOUNDARY_VIOLATION] Path '${requestedPath}' escapes workspace root '${workspaceRoot}'`
    );
    this.name = "PathTraversalError";
  }
}

/**
 * Resolves a workspace-relative path safely, handling symlinked workspace roots
 * (such as `/tmp` on macOS/Linux) consistently while preventing `..` escapes.
 */
export function resolveSafeWorkspacePath(workspaceRoot: string, requestedPath: string): string {
  const canonicalRoot = existsSync(workspaceRoot)
    ? realpathSync(workspaceRoot)
    : resolve(workspaceRoot);
  const candidate = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(canonicalRoot, requestedPath);

  // If parent exists, resolve its realpath so symlinked roots compare cleanly
  const parentDir = dirname(candidate);
  const canonicalCandidate = existsSync(parentDir)
    ? join(realpathSync(parentDir), candidate.slice(parentDir.length))
    : candidate;

  const rel = relative(canonicalRoot, canonicalCandidate);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new PathTraversalError(requestedPath, workspaceRoot);
  }

  return canonicalCandidate;
}

export const BUILT_IN_AGENT_TOOLS: readonly AgentToolDefinition[] = Object.freeze([
  {
    name: "read_file",
    description: "Read the contents of a file in the workspace.",
    mutatesState: false,
    parametersJsonSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        startLine: { type: "number" },
        endLine: { type: "number" }
      },
      required: ["path"]
    }
  },
  {
    name: "write_file",
    description: "Create or overwrite a file in the workspace.",
    mutatesState: true,
    parametersJsonSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "edit_file",
    description: "Replace an exact target substring in a workspace file.",
    mutatesState: true,
    parametersJsonSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        targetContent: { type: "string" },
        replacementContent: { type: "string" }
      },
      required: ["path", "targetContent", "replacementContent"]
    }
  },
  {
    name: "list_dir",
    description: "List entries in a workspace directory.",
    mutatesState: false,
    parametersJsonSchema: {
      type: "object",
      properties: {
        path: { type: "string" }
      }
    }
  },
  {
    name: "search_code",
    description: "Search for a text pattern across workspace files.",
    mutatesState: false,
    parametersJsonSchema: {
      type: "object",
      properties: {
        query: { type: "string" }
      },
      required: ["query"]
    }
  },
  {
    name: "run_terminal_command",
    description: "Run a shell command in the workspace with offline-sanitized environment.",
    mutatesState: true,
    parametersJsonSchema: {
      type: "object",
      properties: {
        command: { type: "string" }
      },
      required: ["command"]
    }
  },
  {
    name: "git_status",
    description: "Inspect git working tree status.",
    mutatesState: false,
    parametersJsonSchema: {
      type: "object",
      properties: {}
    }
  }
]);

export async function executeWorkspaceTool(
  call: AgentToolCall,
  ctx: AgentToolExecutionContext
): Promise<Record<string, unknown>> {
  const toolDef = BUILT_IN_AGENT_TOOLS.find((t) => t.name === call.name);
  if (!toolDef) {
    return { ok: false, error: `Unknown tool '${call.name}'` };
  }

  // Enforce plan-only mode ceiling
  if (ctx.runtimeMode === "plan-only" && toolDef.mutatesState) {
    return {
      ok: false,
      error: `[ERR_MODE_LIMIT] Tool '${call.name}' is forbidden in 'plan-only' mode`
    };
  }

  switch (call.name) {
    case "read_file": {
      const targetPath = resolveSafeWorkspacePath(ctx.workspaceRoot, String(call.arguments.path ?? ""));
      const content = readFileSync(targetPath, "utf8");
      const lines = content.split("\n");
      const start = typeof call.arguments.startLine === "number" ? Math.max(1, call.arguments.startLine) : 1;
      const end =
        typeof call.arguments.endLine === "number"
          ? Math.min(lines.length, call.arguments.endLine)
          : lines.length;
      return {
        ok: true,
        path: String(call.arguments.path),
        content: lines.slice(start - 1, end).join("\n"),
        totalLines: lines.length
      };
    }

    case "write_file": {
      const relPath = String(call.arguments.path ?? "");
      const targetPath = resolveSafeWorkspacePath(ctx.workspaceRoot, relPath);
      const approvalKey = `write_file:${relPath}`;
      if (ctx.runtimeMode === "supervised" && !ctx.sessionApprovedCommands.has(approvalKey)) {
        const approval = await ctx.host.requestApproval(
          {
            requestId: `req_write_${call.id}`,
            threadId: ctx.threadId,
            turnId: ctx.turnId,
            question: `Czy zezwolić na zapis pliku (\`write_file\`): \`${relPath}\`?`,
            options: [
              { id: "allow-once", label: "Zezwól raz" },
              { id: "allow-session", label: "Zezwól w tej sesji" },
              { id: "decline", label: "Odrzuć" }
            ]
          },
          ctx.signal
        );
        if (approval.selectedOptionId === "decline") {
          return { ok: false, declined: true, error: "File write declined by user" };
        }
        if (approval.selectedOptionId === "allow-session") {
          ctx.sessionApprovedCommands.add(approvalKey);
        }
      }
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, String(call.arguments.content ?? ""), "utf8");
      return {
        ok: true,
        path: relPath
      };
    }

    case "edit_file": {
      const relPath = String(call.arguments.path ?? "");
      const targetPath = resolveSafeWorkspacePath(ctx.workspaceRoot, relPath);
      const approvalKey = `edit_file:${relPath}`;
      if (ctx.runtimeMode === "supervised" && !ctx.sessionApprovedCommands.has(approvalKey)) {
        const approval = await ctx.host.requestApproval(
          {
            requestId: `req_edit_${call.id}`,
            threadId: ctx.threadId,
            turnId: ctx.turnId,
            question: `Czy zezwolić na edycję pliku (\`edit_file\`): \`${relPath}\`?`,
            options: [
              { id: "allow-once", label: "Zezwól raz" },
              { id: "allow-session", label: "Zezwól w tej sesji" },
              { id: "decline", label: "Odrzuć" }
            ]
          },
          ctx.signal
        );
        if (approval.selectedOptionId === "decline") {
          return { ok: false, declined: true, error: "File edit declined by user" };
        }
        if (approval.selectedOptionId === "allow-session") {
          ctx.sessionApprovedCommands.add(approvalKey);
        }
      }
      const existing = readFileSync(targetPath, "utf8");
      const target = String(call.arguments.targetContent ?? "");
      const replacement = String(call.arguments.replacementContent ?? "");
      if (!existing.includes(target)) {
        return {
          ok: false,
          error: `Target substring not found in '${relPath}'`
        };
      }
      const updated = existing.replace(target, replacement);
      writeFileSync(targetPath, updated, "utf8");
      return {
        ok: true,
        path: relPath
      };
    }

    case "list_dir": {
      const relDir = String(call.arguments.path ?? ".");
      const targetDir = resolveSafeWorkspacePath(ctx.workspaceRoot, relDir);
      const entries = readdirSync(targetDir, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "dir" : "file"
      }));
      return { ok: true, entries };
    }

    case "search_code": {
      const query = String(call.arguments.query ?? "");
      const matches: Array<{ file: string; line: number; text: string }> = [];
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") {
            continue;
          }
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(fullPath);
          } else if (entry.isFile() && statSync(fullPath).size < 512_000) {
            const text = readFileSync(fullPath, "utf8");
            const lines = text.split("\n");
            for (let i = 0; i < lines.length; i += 1) {
              if (lines[i]!.includes(query)) {
                matches.push({
                  file: relative(ctx.workspaceRoot, fullPath),
                  line: i + 1,
                  text: lines[i]!
                });
              }
            }
          }
        }
      };
      walk(ctx.workspaceRoot);
      return { ok: true, matches };
    }

    case "run_terminal_command": {
      const command = String(call.arguments.command ?? "");
      if (!command.trim()) {
        return { ok: false, error: "Empty command" };
      }

      if (ctx.runtimeMode === "supervised" && !ctx.sessionApprovedCommands.has(command)) {
        const approval = await ctx.host.requestApproval(
          {
            requestId: `req_cmd_${call.id}`,
            threadId: ctx.threadId,
            turnId: ctx.turnId,
            question: `Czy zezwolić na uruchomienie komendy: \`${command}\`?`,
            options: [
              { id: "allow-once", label: "Zezwól raz" },
              { id: "allow-session", label: "Zezwól w tej sesji" },
              { id: "decline", label: "Odrzuć" }
            ]
          },
          ctx.signal
        );

        if (approval.selectedOptionId === "decline") {
          return {
            ok: false,
            declined: true,
            error: "Command execution declined by user"
          };
        }

        if (approval.selectedOptionId === "allow-session") {
          ctx.sessionApprovedCommands.add(command);
        }
      }

      const sanitizedEnv = sanitizeSubprocessEnv(process.env);
      const output = await new Promise<{ exitCode: number; stdout: string; stderr: string }>(
        (resolvePromise) => {
          const child = spawn("bash", ["-c", command], {
            cwd: ctx.workspaceRoot,
            env: sanitizedEnv
          });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
          });
          child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
          });
          child.on("close", (code) => {
            resolvePromise({ exitCode: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
          });
        }
      );

      return {
        ok: output.exitCode === 0,
        ...output
      };
    }

    case "git_status": {
      const statusOut = execFileSync("git", ["status", "--short"], {
        cwd: ctx.workspaceRoot,
        encoding: "utf8"
      }).trim();
      return { ok: true, status: statusOut };
    }

    default:
      return { ok: false, error: `Unhandled tool '${call.name}'` };
  }
}
