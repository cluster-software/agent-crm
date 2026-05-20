import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureBundledClientSecret,
  resolveGwsConfigDir,
} from "./gws-bootstrap.js";

describe("gws-bootstrap", () => {
  let tmp: string;
  const prevEnv = { ...process.env };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "acrm-gws-bootstrap-"));
    process.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR = tmp;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...prevEnv };
  });

  it("resolveGwsConfigDir honors GOOGLE_WORKSPACE_CLI_CONFIG_DIR", () => {
    expect(resolveGwsConfigDir()).toBe(tmp);
  });

  it("ensureBundledClientSecret writes client_secret.json when missing (env-var creds)", () => {
    process.env.ACRM_GOOGLE_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
    process.env.ACRM_GOOGLE_CLIENT_SECRET = "test-client-secret";
    const result = ensureBundledClientSecret();
    expect(result.wrote).toBe(true);
    expect(result.path).toBe(join(tmp, "client_secret.json"));
    const file = JSON.parse(readFileSync(result.path, "utf8")) as {
      installed: { client_id: string; client_secret: string };
    };
    expect(file.installed.client_id).toBe(
      "test-client-id.apps.googleusercontent.com",
    );
    expect(file.installed.client_secret).toBe("test-client-secret");
  });

  it("ensureBundledClientSecret leaves an existing file alone", () => {
    const path = join(tmp, "client_secret.json");
    const userSupplied = '{"installed":{"client_id":"user-owned","client_secret":"s"}}';
    writeFileSync(path, userSupplied);
    process.env.ACRM_GOOGLE_CLIENT_ID = "bundled";
    process.env.ACRM_GOOGLE_CLIENT_SECRET = "bundled-secret";
    const result = ensureBundledClientSecret();
    expect(result.wrote).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(userSupplied);
  });

  it("ensureBundledClientSecret throws with a clear hint when no creds are available", () => {
    delete process.env.ACRM_GOOGLE_CLIENT_ID;
    delete process.env.ACRM_GOOGLE_CLIENT_SECRET;
    expect(() => ensureBundledClientSecret()).toThrowError(
      /no Google OAuth client available/i,
    );
  });
});
