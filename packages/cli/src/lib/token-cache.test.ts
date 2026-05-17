import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import {
  isExpired,
  readToken,
  tokenCacheDir,
  tokenCachePath,
  writeToken,
} from "@agent-crm/sdk";
import { acrmConfigDir } from "./config-dir.js";

describe("token cache", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "acrm-token-cache-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("uses the explicit configDir argument", () => {
    expect(tokenCacheDir(tmp)).toBe(tmp);
    expect(tokenCachePath("granola", tmp)).toBe(path.join(tmp, "granola.json"));
  });

  it("falls back to ~/.config/acrm when no configDir is provided", () => {
    const def = path.join(homedir(), ".config", "acrm");
    expect(tokenCacheDir()).toBe(def);
    expect(tokenCachePath("granola")).toBe(path.join(def, "granola.json"));
  });

  it("returns null when no token is cached", async () => {
    expect(await readToken("granola", tmp)).toBeNull();
  });

  it("round-trips a token", async () => {
    const file = await writeToken(
      {
        provider: "granola",
        access_token: "abc123",
        token_type: "Bearer",
        expires_at: 1234,
      },
      tmp,
    );
    expect(file).toBe(path.join(tmp, "granola.json"));
    const read = await readToken("granola", tmp);
    expect(read?.access_token).toBe("abc123");
    expect(read?.expires_at).toBe(1234);
  });

  it("writes the token file with 0600 permissions", async () => {
    await writeToken(
      {
        provider: "granola",
        access_token: "secret",
      },
      tmp,
    );
    const file = tokenCachePath("granola", tmp);
    const mode = statSync(file).mode & 0o777;
    // On some filesystems (e.g. tmpfs with restrictive umasks) the exact
    // mode can vary, but the token must NOT be group/world readable.
    expect(mode & 0o077).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8")).access_token).toBe(
      "secret",
    );
  });

  it("treats malformed JSON as no token rather than crashing the caller", async () => {
    const file = tokenCachePath("granola", tmp);
    const fs = await import("node:fs/promises");
    await fs.mkdir(tmp, { recursive: true });
    await fs.writeFile(file, "not json");
    expect(await readToken("granola", tmp)).toBeNull();
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

describe("acrmConfigDir (CLI helper)", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.ACRM_CONFIG_DIR;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.ACRM_CONFIG_DIR;
    else process.env.ACRM_CONFIG_DIR = savedEnv;
  });

  it("honors ACRM_CONFIG_DIR when set", () => {
    process.env.ACRM_CONFIG_DIR = "/tmp/custom-acrm";
    expect(acrmConfigDir()).toBe("/tmp/custom-acrm");
  });

  it("falls back to ~/.config/acrm when ACRM_CONFIG_DIR is unset", () => {
    delete process.env.ACRM_CONFIG_DIR;
    expect(acrmConfigDir()).toBe(path.join(homedir(), ".config", "acrm"));
  });

  it("treats an empty/whitespace ACRM_CONFIG_DIR as unset", () => {
    process.env.ACRM_CONFIG_DIR = "  ";
    expect(acrmConfigDir()).toBe(path.join(homedir(), ".config", "acrm"));
  });
});
