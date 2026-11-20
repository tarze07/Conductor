import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { ZodType } from "zod";
import {
  JsonRpcNotificationEnvelopeSchema,
  JsonRpcRequestEnvelopeSchema,
  JsonRpcResponseEnvelopeSchema,
  type JsonRpcId
} from "./schema/acp-v1.gen.js";

export const JSONRPC_ERROR_PARSE = -32700;
export const JSONRPC_ERROR_INVALID_REQUEST = -32600;
export const JSONRPC_ERROR_METHOD_NOT_FOUND = -32601;
export const JSONRPC_ERROR_INVALID_PARAMS = -32602;
export const JSONRPC_ERROR_INTERNAL = -32603;
export const JSONRPC_ERROR_TIMEOUT = -32000;
export const JSONRPC_ERROR_PERMISSION_DENIED = -32001;

export class AcpJsonRpcError extends Error {
  public readonly code: number;
  public readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "AcpJsonRpcError";
    this.code = code;
    this.data = data;
  }
}

interface PendingRpcRequest {
  readonly id: number;
  readonly method: string;
  readonly responseSchema?: ZodType<unknown>;
  readonly timer?: ReturnType<typeof setTimeout>;
  readonly onAbort?: () => void;
  readonly signal?: AbortSignal;
  resolve(value: unknown): void;
  reject(reason: Error): void;
}

export type AcpRequestHandler<TParams = unknown, TResult = unknown> = (
  params: TParams,
  requestId: JsonRpcId
) => Promise<TResult> | TResult;

export type AcpNotificationHandler<TParams = unknown> = (
  params: TParams
) => Promise<void> | void;

export interface AcpJsonRpcConnectionOptions {
  readonly readable: Readable;
  readonly writable: Writable;
  readonly onOutboundFrame?: (frame: Record<string, unknown>) => void;
  readonly onInboundFrame?: (frame: Record<string, unknown>) => void;
  readonly onProtocolError?: (error: Error, rawLine?: string) => void;
}

/**
 * Specification-compliant newline-delimited JSON-RPC 2.0 connection over stdio
 * for Agent Client Protocol (ACP) v1.
 *
 * Supports:
 * - Monotonically incrementing integer request IDs (`1, 2, 3, ...`)
 * - Request/response correlation with per-call timeouts and Zod validation
 * - Client -> Agent notifications (`session/cancel`)
 * - Agent -> Client notifications (`session/update`)
 * - Bidirectional Agent -> Client RPC requests (`session/request_permission`, `fs/read_text_file`, `fs/write_text_file`)
 * - Standard `-32601 Method not found` error replies for unimplemented methods (e.g. `terminal/*`)
 */
export class AcpJsonRpcConnection {
  private readonly writable: Writable;
  private readonly rl: ReadlineInterface;
  private readonly pendingRequests = new Map<JsonRpcId, PendingRpcRequest>();
  private readonly requestHandlers = new Map<string, AcpRequestHandler>();
  private readonly notificationHandlers = new Map<string, Set<AcpNotificationHandler>>();
  private readonly onOutboundFrame?: (frame: Record<string, unknown>) => void;
  private readonly onInboundFrame?: (frame: Record<string, unknown>) => void;
  private readonly onProtocolError?: (error: Error, rawLine?: string) => void;
  private nextRequestId = 1;
  private closed = false;

  constructor(options: AcpJsonRpcConnectionOptions) {
    this.writable = options.writable;
    this.onOutboundFrame = options.onOutboundFrame;
    this.onInboundFrame = options.onInboundFrame;
    this.onProtocolError = options.onProtocolError;

    this.rl = createInterface({
      input: options.readable,
      crlfDelay: Infinity
    });

    this.rl.on("line", (line) => {
      void this.handleLine(line);
    });

    this.rl.on("close", () => {
      this.close(new Error("ACP stdio stream closed"));
    });
  }

  public isClosed(): boolean {
    return this.closed;
  }

  public sendRequest<TParams, TResult>(
    method: string,
    params: TParams,
    options: {
      readonly requestSchema?: ZodType<TParams>;
      readonly responseSchema?: ZodType<TResult>;
      readonly timeoutMs?: number;
      readonly signal?: AbortSignal;
    } = {}
  ): Promise<TResult> {
    if (this.closed) {
      return Promise.reject(new Error(`Cannot send ACP request '${method}': connection is closed`));
    }

    if (options.requestSchema) {
      const parsedReq = options.requestSchema.safeParse(params);
      if (!parsedReq.success) {
        return Promise.reject(
          new AcpJsonRpcError(
            JSONRPC_ERROR_INVALID_PARAMS,
            `Invalid outgoing ACP request params for '${method}': ${parsedReq.error.message}`
          )
        );
      }
    }

    const id = this.nextRequestId++;
    const envelope: Record<string, unknown> = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };

    return new Promise<TResult>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new Error(`ACP request '${method}' aborted before send`));
        return;
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      if (options.timeoutMs && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pendingRequests.delete(id);
          if (options.signal && onAbort) {
            options.signal.removeEventListener("abort", onAbort);
          }
          reject(
            new AcpJsonRpcError(
              JSONRPC_ERROR_TIMEOUT,
              `ERR_ACP_TIMEOUT: Request '${method}' (id=${id}) timed out after ${options.timeoutMs}ms`
            )
          );
        }, options.timeoutMs);
      }

      const onAbort = options.signal
        ? () => {
            if (timer) {
              clearTimeout(timer);
            }
            this.pendingRequests.delete(id);
            reject(new Error(`ACP request '${method}' (id=${id}) aborted`));
          }
        : undefined;

      if (options.signal && onAbort) {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      this.pendingRequests.set(id, {
        id,
        method,
        responseSchema: options.responseSchema as ZodType<unknown> | undefined,
        timer,
        onAbort,
        signal: options.signal,
        resolve: resolve as (value: unknown) => void,
        reject
      });

      try {
        this.writeFrame(envelope);
      } catch (err) {
        if (timer) {
          clearTimeout(timer);
        }
        if (options.signal && onAbort) {
          options.signal.removeEventListener("abort", onAbort);
        }
        this.pendingRequests.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  public sendNotification<TParams>(
    method: string,
    params: TParams,
    schema?: ZodType<TParams>
  ): void {
    if (this.closed) {
      return;
    }
    if (schema) {
      schema.parse(params);
    }
    this.writeFrame({
      jsonrpc: "2.0",
      method,
      params
    });
  }

  public onRequest<TParams = unknown, TResult = unknown>(
    method: string,
    handler: AcpRequestHandler<TParams, TResult>,
    requestSchema?: ZodType<TParams>
  ): () => void {
    const wrapped: AcpRequestHandler = async (rawParams, requestId) => {
      if (requestSchema) {
        const parsed = requestSchema.safeParse(rawParams);
        if (!parsed.success) {
          throw new AcpJsonRpcError(
            JSONRPC_ERROR_INVALID_PARAMS,
            `Invalid params for '${method}': ${parsed.error.message}`
          );
        }
        return await handler(parsed.data, requestId);
      }
      return await handler(rawParams as TParams, requestId);
    };

    this.requestHandlers.set(method, wrapped);
    return () => {
      this.requestHandlers.delete(method);
    };
  }

  public onNotification<TParams = unknown>(
    method: string,
    handler: AcpNotificationHandler<TParams>,
    notificationSchema?: ZodType<TParams>
  ): () => void {
    let set = this.notificationHandlers.get(method);
    if (!set) {
      set = new Set();
      this.notificationHandlers.set(method, set);
    }
    const wrapped: AcpNotificationHandler = async (rawParams) => {
      if (notificationSchema) {
        const parsed = notificationSchema.safeParse(rawParams);
        if (!parsed.success) {
          this.onProtocolError?.(
            new Error(`Invalid notification params for '${method}': ${parsed.error.message}`)
          );
          return;
        }
        await handler(parsed.data);
        return;
      }
      await handler(rawParams as TParams);
    };
    set.add(wrapped);
    return () => {
      set?.delete(wrapped);
    };
  }

  public close(reason?: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const err = reason ?? new Error("ACP JSON-RPC connection closed");
    for (const [id, pending] of this.pendingRequests.entries()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      if (pending.signal && pending.onAbort) {
        pending.signal.removeEventListener("abort", pending.onAbort);
      }
      pending.reject(err);
      this.pendingRequests.delete(id);
    }
    this.rl.close();
  }

  private writeFrame(frame: Record<string, unknown>): void {
    this.onOutboundFrame?.(frame);
    const serialized = JSON.stringify(frame);
    this.writable.write(`${serialized}\n`);
  }

  private async handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let rawObj: unknown;
    try {
      rawObj = JSON.parse(trimmed);
    } catch {
      // Ignore non-JSON diagnostic lines emitted on stdout by some CLI tools,
      // but notify optional protocol error observer.
      this.onProtocolError?.(new Error("Non-JSON line received on ACP stdout"), trimmed);
      return;
    }

    if (typeof rawObj !== "object" || rawObj === null || Array.isArray(rawObj)) {
      return;
    }

    const msg = rawObj as Record<string, unknown>;
    this.onInboundFrame?.(msg);

    // 1. Agent -> Client Request (has both `id` and `method`)
    if ("method" in msg && typeof msg.method === "string" && "id" in msg && msg.id !== undefined && msg.id !== null) {
      const parsedReq = JsonRpcRequestEnvelopeSchema.safeParse(msg);
      if (!parsedReq.success) {
        this.writeFrame({
          jsonrpc: "2.0",
          id: (msg.id as JsonRpcId) ?? null,
          error: {
            code: JSONRPC_ERROR_INVALID_REQUEST,
            message: "Invalid JSON-RPC request envelope"
          }
        });
        return;
      }

      const { id, method, params } = parsedReq.data;
      const handler = this.requestHandlers.get(method);
      if (!handler) {
        this.writeFrame({
          jsonrpc: "2.0",
          id,
          error: {
            code: JSONRPC_ERROR_METHOD_NOT_FOUND,
            message: `Method not found: ${method}`
          }
        });
        return;
      }

      try {
        const result = await handler(params, id);
        if (!this.closed) {
          this.writeFrame({
            jsonrpc: "2.0",
            id,
            result: result ?? {}
          });
        }
      } catch (err) {
        if (!this.closed) {
          const code = err instanceof AcpJsonRpcError ? err.code : JSONRPC_ERROR_INTERNAL;
          const message = err instanceof Error ? err.message : String(err);
          const data = err instanceof AcpJsonRpcError ? err.data : undefined;
          this.writeFrame({
            jsonrpc: "2.0",
            id,
            error: {
              code,
              message,
              ...(data !== undefined ? { data } : {})
            }
          });
        }
      }
      return;
    }

    // 2. Agent -> Client Notification (has `method`, no `id`)
    if ("method" in msg && typeof msg.method === "string" && !("id" in msg)) {
      const parsedNotif = JsonRpcNotificationEnvelopeSchema.safeParse(msg);
      if (!parsedNotif.success) {
        return;
      }
      const handlers = this.notificationHandlers.get(parsedNotif.data.method);
      if (handlers) {
        for (const h of handlers) {
          try {
            await h(parsedNotif.data.params);
          } catch (err) {
            this.onProtocolError?.(err instanceof Error ? err : new Error(String(err)));
          }
        }
      }
      return;
    }

    // 3. Agent -> Client Response (has `id`, no `method`)
    if ("id" in msg && msg.id !== undefined && msg.id !== null) {
      const parsedRes = JsonRpcResponseEnvelopeSchema.safeParse(msg);
      if (!parsedRes.success) {
        this.onProtocolError?.(new Error(`Invalid JSON-RPC response envelope: ${parsedRes.error.message}`));
        return;
      }

      const { id, result, error } = parsedRes.data;
      if (id === null) {
        return;
      }

      const pending = this.pendingRequests.get(id);
      if (!pending) {
        return;
      }
      this.pendingRequests.delete(id);
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      if (pending.signal && pending.onAbort) {
        pending.signal.removeEventListener("abort", pending.onAbort);
      }

      if (error) {
        pending.reject(new AcpJsonRpcError(error.code, error.message, error.data));
        return;
      }

      if (pending.responseSchema) {
        const validated = pending.responseSchema.safeParse(result);
        if (!validated.success) {
          pending.reject(
            new AcpJsonRpcError(
              JSONRPC_ERROR_INTERNAL,
              `Invalid ACP response payload for '${pending.method}': ${validated.error.message}`
            )
          );
          return;
        }
        pending.resolve(validated.data);
        return;
      }

      pending.resolve(result);
    }
  }
}
