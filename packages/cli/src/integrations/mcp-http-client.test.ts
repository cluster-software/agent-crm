import { describe, expect, it, vi } from "vitest";
import {
  McpHttpClient,
  unwrapToolResult,
} from "@agent-crm/sdk";

function mockFetch(impl: (req: Request) => Promise<Response> | Response) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as string, init as RequestInit);
    return await impl(req);
  });
  return fn as unknown as typeof fetch;
}

describe("McpHttpClient", () => {
  it("posts a JSON-RPC tools/call envelope with bearer token", async () => {
    let capturedBody: string | null = null;
    let capturedAuth: string | null = null;
    const client = new McpHttpClient({
      endpoint: "https://mcp.example.com/mcp",
      bearerToken: "TOKEN",
      fetchImpl: mockFetch(async (req) => {
        capturedBody = await req.text();
        capturedAuth = req.headers.get("authorization");
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    });
    const result = await client.callTool("list_meetings", {
      time_range: "last_week",
    });
    expect(result).toEqual({ ok: true });
    expect(capturedAuth).toBe("Bearer TOKEN");
    const parsed = JSON.parse(capturedBody!);
    expect(parsed.jsonrpc).toBe("2.0");
    expect(parsed.method).toBe("tools/call");
    expect(parsed.params.name).toBe("list_meetings");
    expect(parsed.params.arguments).toEqual({ time_range: "last_week" });
  });

  it("turns 401 into a friendly run-acrm-auth hint", async () => {
    const client = new McpHttpClient({
      endpoint: "https://mcp.example.com/mcp",
      bearerToken: "BAD",
      fetchImpl: mockFetch(
        async () => new Response("nope", { status: 401 }),
      ),
    });
    await expect(client.callTool("x", {})).rejects.toThrow(
      /not authenticated/i,
    );
  });

  it("surfaces JSON-RPC error fields", async () => {
    const client = new McpHttpClient({
      endpoint: "https://mcp.example.com/mcp",
      bearerToken: "T",
      fetchImpl: mockFetch(
        async () =>
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              error: { code: -32602, message: "invalid params" },
            }),
            { status: 200 },
          ),
      ),
    });
    await expect(client.callTool("x", {})).rejects.toThrow(/invalid params/);
  });

  it("parses streamable HTTP / SSE body shape", async () => {
    const sse = [
      ": ping",
      "",
      "event: message",
      `data: ${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { hello: "world" },
      })}`,
      "",
    ].join("\n");
    const client = new McpHttpClient({
      endpoint: "https://mcp.example.com/mcp",
      bearerToken: "T",
      fetchImpl: mockFetch(
        async () =>
          new Response(sse, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
      ),
    });
    const result = await client.callTool("x", {});
    expect(result).toEqual({ hello: "world" });
  });
});

describe("unwrapToolResult", () => {
  it("returns the inner JSON when content is a single text block", () => {
    const wrapped = {
      content: [{ type: "text", text: '{"a":1}' }],
    };
    expect(unwrapToolResult(wrapped)).toEqual({ a: 1 });
  });

  it("returns the raw text when it isn't JSON", () => {
    const wrapped = {
      content: [{ type: "text", text: "plain transcript bytes" }],
    };
    expect(unwrapToolResult(wrapped)).toBe("plain transcript bytes");
  });

  it("returns the result unchanged when content shape is not the single-text wrapper", () => {
    const r = { content: [{ type: "image", data: "..." }] };
    expect(unwrapToolResult(r)).toBe(r);
  });

  it("passes through non-object values", () => {
    expect(unwrapToolResult("hello")).toBe("hello");
    expect(unwrapToolResult(42)).toBe(42);
    expect(unwrapToolResult(null)).toBe(null);
  });
});
