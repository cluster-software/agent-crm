import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  isExpired,
  readToken,
  tokenCacheDir,
  tokenCachePath,
  writeToken,
} from "./token-cache.js";

describe("token cache", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "acrm-token-cache-"));
    process.env.ACRM_CONFIG_DIR = tmp;
  });

  afterEach(() => {
    delete process.env.ACRM_CONFIG_DIR;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("honors ACRM_CONFIG_DIR for cache directory", () => {
    expect(tokenCacheDir()).toBe(tmp);
    expect(tokenCachePath("granola")).toBe(path.join(tmp, "granola.json"));
  });

  it("returns null when no token is cached", async () => {
    expect(await readToken("granola")).toBeNull();
  });

  it("round-trips a token", async () => {
    const file = await writeToken({
      provider: "granola",
      access_token: "abc123",
      token_type: "Bearer",
      expires_at: 1234,
    });
    expect(file).toBe(path.join(tmp, "granola.json"));
    const read = await readToken("granola");
    expect(read?.access_token).toBe("abc123");
    expect(read?.expires_at).toBe(1234);
  });

  it("writes the token file with 0600 permissions", async () => {
    await writeToken({
      provider: "granola",
      access_token: "secret",
    });
    const file = tokenCachePath("granola");
    const mode = statSync(file).mode & 0o777;
    // On some filesystems (e.g. tmpfs with restrictive umasks) the exact
    // mode can vary, but the token must NOT be group/world readable.
    expect(mode & 0o077).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8")).access_token).toBe(
      "secret",
    );
  });

  it("treats malformed JSON as no token rather than crashing the caller", async () => {
    const file = tokenCachePath("granola");
    const fs = await import("node:fs/promises");
    await fs.mkdir(tmp, { recursive: true });
    await fs.writeFile(file, "not json");
    await expect(readToken("granola")).rejects.toThrow();
  });

  it("isExpired returns false when expires_at is absent", () => {
    expect(isExpired({ provider: "granola", access_token: "x" })).toBe(false);
  });

  it("isExpired returns true when expiry is in the past", () => {
    const nowSec = Date.now() / 1000;
    expect(
      isExpired({
        provider: "granola",
        access_token: "x",
        expires_at: nowSec - 60,
      }),
    ).toBe(true);
  });

  it("isExpired honors skew", () => {
    const nowSec = Date.now() / 1000;
    expect(
      isExpired(
        {
          provider: "granola",
          access_token: "x",
          expires_at: nowSec + 10,
        },
        30,
      ),
    ).toBe(true);
  });
});
