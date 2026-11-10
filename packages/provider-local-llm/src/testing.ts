import http from "node:http";

export interface MockLocalLlmServerStep {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly sseChunks?: readonly unknown[];
  readonly jsonBody?: unknown;
}

export interface RunningMockLocalLlmServer {
  readonly baseUrl: string;
  readonly receivedRequests: Array<{
    readonly url: string;
    readonly body: Record<string, unknown>;
  }>;
  readonly close: () => Promise<void>;
}

/**
 * Starts a loopback mock vLLM / Ollama server on `127.0.0.1` for deterministic offline testing.
 */
export async function startMockLocalLlmServer(
  steps: readonly MockLocalLlmServerStep[],
  availableModels: readonly string[] = ["qwen3-coder-30b", "deepseek-r1-distill"]
): Promise<RunningMockLocalLlmServer> {
  const receivedRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
  let stepIndex = 0;

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: availableModels.map((id) => ({ id, object: "model" }))
        })
      );
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const parsedBody = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
      receivedRequests.push({
        url: req.url ?? "",
        body: parsedBody
      });

      const currentStep = steps[Math.min(stepIndex, steps.length - 1)]!;
      stepIndex += 1;

      const status = currentStep.status ?? 200;
      if (currentStep.sseChunks) {
        res.writeHead(status, {
          "content-type": "text/event-stream",
          ...currentStep.headers
        });
        for (const chunk of currentStep.sseChunks) {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      res.writeHead(status, {
        "content-type": "application/json",
        ...currentStep.headers
      });
      res.end(JSON.stringify(currentStep.jsonBody ?? {}));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    receivedRequests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
