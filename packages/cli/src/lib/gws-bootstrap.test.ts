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

  it("ensureBundledClientSecret writes client_secret.json with env-var creds when set", () => {
    process.env.ACRM_GOOGLE_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
    process.env.ACRM_GOOGLE_CLIENT_SECRET = "test-client-secret";
    process.env.ACRM_GOOGLE_PROJECT_ID = "test-proj";
    const result = ensureBundledClientSecret();
    expect(result.wrote).toBe(true);
    expect(result.path).toBe(join(tmp, "client_secret.json"));
    const file = JSON.parse(readFileSync(result.path, "utf8")) as {
      installed: {
        client_id: string;
        client_secret: string;
        project_id: string;
      };
    };
    expect(file.installed.client_id).toBe(
      "test-client-id.apps.googleusercontent.com",
    );
    expect(file.installed.client_secret).toBe("test-client-secret");
    expect(file.installed.project_id).toBe("test-proj");
  });

  it("ensureBundledClientSecret falls back to bundled creds when env is unset", () => {
    delete process.env.ACRM_GOOGLE_CLIENT_ID;
    delete process.env.ACRM_GOOGLE_CLIENT_SECRET;
    delete process.env.ACRM_GOOGLE_PROJECT_ID;
    const result = ensureBundledClientSecret();
    expect(result.wrote).toBe(true);
    const file = JSON.parse(readFileSync(result.path, "utf8")) as {
      installed: { client_id: string; project_id: string };
    };
    // The bundled GCP project for acrm's production OAuth client.
    expect(file.installed.project_id).toBe("agent-crm-prod");
    // Bundled client_id matches the value committed to source.
    expect(file.installed.client_id).toMatch(
      /^\d+-.+\.apps\.googleusercontent\.com$/,
    );
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

  it("ensureBundledClientSecret defaults project_id when env-var creds omit it", () => {
    process.env.ACRM_GOOGLE_CLIENT_ID = "byo-id";
    process.env.ACRM_GOOGLE_CLIENT_SECRET = "byo-secret";
    delete process.env.ACRM_GOOGLE_PROJECT_ID;
    const result = ensureBundledClientSecret();
    const file = JSON.parse(readFileSync(result.path, "utf8")) as {
      installed: { project_id: string };
    };
    expect(file.installed.project_id).toBe("user-supplied");
  });
});
