import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  buildAuthorizationUrl,
  generatePkcePair,
  generateState,
} from "./oauth-pkce.js";

describe("generatePkcePair", () => {
  it("returns base64url-safe verifier and a SHA-256 challenge", () => {
    const pair = generatePkcePair();
    expect(pair.code_challenge_method).toBe("S256");
    // RFC 7636 requires verifier length 43–128.
    expect(pair.code_verifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.code_verifier.length).toBeLessThanOrEqual(128);
    expect(pair.code_verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pair.code_challenge).toMatch(/^[A-Za-z0-9_-]+$/);

    const expected = createHash("sha256")
      .update(pair.code_verifier)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    expect(pair.code_challenge).toBe(expected);
  });

  it("uses the injected random source deterministically", () => {
    const fixed = (n: number) => Buffer.alloc(n, 0x42);
    const a = generatePkcePair(fixed);
    const b = generatePkcePair(fixed);
    expect(a).toEqual(b);
  });
});

describe("generateState", () => {
  it("is base64url and reasonably long", () => {
    const s = generateState();
    expect(s.length).toBeGreaterThanOrEqual(20);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("buildAuthorizationUrl", () => {
  it("encodes all required PKCE parameters", () => {
    const url = buildAuthorizationUrl({
      authorization_endpoint: "https://mcp.granola.ai/authorize",
      client_id: "acrm-cli",
      redirect_uri: "http://127.0.0.1:54321/callback",
      state: "STATE",
      code_challenge: "CHAL",
      scope: "transcripts.read",
    });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://mcp.granola.ai/authorize");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe("acrm-cli");
    expect(u.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:54321/callback",
    );
    expect(u.searchParams.get("state")).toBe("STATE");
    expect(u.searchParams.get("code_challenge")).toBe("CHAL");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("scope")).toBe("transcripts.read");
  });

  it("omits scope when not provided", () => {
    const url = buildAuthorizationUrl({
      authorization_endpoint: "https://example.com/authorize",
      client_id: "cid",
      redirect_uri: "http://127.0.0.1:1234/callback",
      state: "s",
      code_challenge: "c",
    });
    const u = new URL(url);
    expect(u.searchParams.has("scope")).toBe(false);
  });

  it("preserves existing query string on the authorization endpoint", () => {
    const url = buildAuthorizationUrl({
      authorization_endpoint: "https://example.com/authorize?tenant=foo",
      client_id: "cid",
      redirect_uri: "http://127.0.0.1:1234/callback",
      state: "s",
      code_challenge: "c",
    });
    const u = new URL(url);
    expect(u.searchParams.get("tenant")).toBe("foo");
    expect(u.searchParams.get("client_id")).toBe("cid");
  });
});
