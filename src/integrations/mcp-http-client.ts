// Minimal MCP-over-HTTP client. Implements just enough of the Streamable HTTP
// transport (POST JSON-RPC, single response) to call `tools/call` on a remote
// MCP server with a Bearer token. We do not negotiate sessions, subscribe to
// SSE, or handle batches — every transcript fetch is a one-shot tool call.

import { AcrmError, ERR } from "../lib/errors.js";

export type McpToolCallArgs = Record<string, unknown>;

export type McpAuthState =
  | { kind: "ok" }
  | { kind: "unauthorized"; message: string };

export type McpHttpClientOpts = {
  endpoint: string;
  bearerToken: string;
  fetchImpl?: typeof fetch;
};

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export class McpHttpClient {
  private readonly endpoint: string;
  private readonly bearerToken: string;
  private readonly fetchImpl: typeof fetch;
  private nextId = 1;

  constructor(opts: McpHttpClientOpts) {
    this.endpoint = opts.endpoint;
    this.bearerToken = opts.bearerToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async callTool(
    name: string,
    args: McpToolCallArgs,
  ): Promise<unknown> {
    return this.rpc("tools/call", { name, arguments: args });
  }

  private async rpc(method: string, params: unknown): Promise<unknown> {
    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: this.nextId++,
      method,
      params,
    };
    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${this.bearerToken}`,
        },
        body: JSON.stringify(req),
      });
    } catch (e) {
      throw new AcrmError(
        `MCP request failed: ${e instanceof Error ? e.message : String(e)}`,
        ERR.IMPORT,
      );
    }

    if (res.status === 401 || res.status === 403) {
      throw new AcrmError(
        `not authenticated with MCP server at ${this.endpoint}`,
        ERR.IMPORT,
        "run: acrm auth granola",
      );
    }

    const text = await res.text();
    if (!res.ok) {
      throw new AcrmError(
        `MCP server returned HTTP ${res.status}: ${truncate(text, 200)}`,
        ERR.IMPORT,
      );
    }

    // Streamable HTTP can return either JSON or SSE. We only need the simple
    // JSON case — if we see SSE, extract the data line.
    const body = parseJsonRpcBody(text);
    if (body.error) {
      throw new AcrmError(
        `MCP error ${body.error.code}: ${body.error.message}`,
        ERR.IMPORT,
      );
    }
    return body.result;
  }
}

function parseJsonRpcBody(text: string): JsonRpcResponse {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new AcrmError("MCP server returned empty body", ERR.IMPORT);
  }
  // Pure JSON response.
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as JsonRpcResponse;
      return parsed;
    } catch (e) {
      throw new AcrmError(
        `MCP server returned invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
        ERR.IMPORT,
      );
    }
  }
  // SSE response — find the last `data:` payload (the response event).
  const dataLines: string[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (!dataLines.length) {
    throw new AcrmError(
      `MCP server returned unexpected body shape: ${truncate(trimmed, 200)}`,
      ERR.IMPORT,
    );
  }
  // Last data event is the response; earlier ones may be progress notifications.
  const last = dataLines[dataLines.length - 1]!;
  try {
    return JSON.parse(last) as JsonRpcResponse;
  } catch (e) {
    throw new AcrmError(
      `MCP server returned invalid SSE JSON: ${e instanceof Error ? e.message : String(e)}`,
      ERR.IMPORT,
    );
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// MCP `tools/call` results are wrapped in `{ content: [{ type, text|...}, ...] }`.
// Most Granola tools return a single JSON-encoded text block.
export function unwrapToolResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const r = result as Record<string, unknown>;
  if (!Array.isArray(r.content)) return result;
  const content = r.content as Array<Record<string, unknown>>;
  if (content.length === 1 && content[0]?.type === "text") {
    const text = content[0].text;
    if (typeof text === "string") {
      const trimmed = text.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          return JSON.parse(trimmed);
        } catch {
          return text;
        }
      }
      return text;
    }
  }
  return result;
}
