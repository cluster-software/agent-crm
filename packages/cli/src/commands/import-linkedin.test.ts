import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ERR, Workspace, exec, type AcrmError } from "@agent-crm/sdk";
import { __test as linkedinCommandTest } from "./import-linkedin.js";
import {
  LINKEDIN_NOT_CONNECTED_HINT,
  LINKEDIN_NOT_CONNECTED_MESSAGE,
} from "../lib/cloud-workspace.js";

describe("import linkedin command", () => {
  const oldSyncEngineUrl = process.env.ACRM_SYNC_ENGINE_URL;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (oldSyncEngineUrl === undefined) delete process.env.ACRM_SYNC_ENGINE_URL;
    else process.env.ACRM_SYNC_ENGINE_URL = oldSyncEngineUrl;
  });

  it("imports relations from the hosted sync-engine export endpoint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acrm-linkedin-import-"));
    const workspacePath = join(dir, "workspace.acrm");
    const ws = await Workspace.create(workspacePath);
    await ws.close();
    process.env.ACRM_SYNC_ENGINE_URL = "https://sync.example.com";
    const fetchMock = vi.fn(async () => Response.json({
      ok: true,
      data: {
        relations: [
          {
            object: "UserRelation",
            member_id: "member-1",
            created_at: 1742051769000,
            first_name: "Ada",
            last_name: "Lovelace",
            headline: "Founder at Analytical Engines",
            public_identifier: "ada-lovelace",
            public_profile_url: "https://www.linkedin.com/in/ada-lovelace/",
          },
        ],
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await linkedinCommandTest.runImportLinkedinNetwork({
        workspace: workspacePath,
      });

      expect(result.stats.people_created).toBe(1);
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toContain("/integrations/linkedin/relations/export");
      const reopened = await Workspace.open(workspacePath);
      try {
        await expect(singleValue(reopened, "linkedin_url")).resolves.toBe("linkedin.com/in/ada-lovelace");
        await expect(singleValue(reopened, "linkedin_connected_at")).resolves.toBe("2025-03-15T15:16:09.000Z");
      } finally {
        await reopened.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("passes cutoff-date to the relations export endpoint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acrm-linkedin-import-"));
    const workspacePath = join(dir, "workspace.acrm");
    const ws = await Workspace.create(workspacePath);
    await ws.close();
    process.env.ACRM_SYNC_ENGINE_URL = "https://sync.example.com";
    const fetchMock = vi.fn(async () => Response.json({
      ok: true,
      data: { relations: [] },
    }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      await linkedinCommandTest.runImportLinkedinNetwork({
        workspace: workspacePath,
        cutoffDate: "2026-04-25",
      });

      const [url] = fetchMock.mock.calls[0] as [string];
      const metadata = JSON.parse(await readFile(join(dir, ".agent-crm-cloud.json"), "utf8")) as {
        workspaceId: string;
      };
      expect(url).toBe(
        `https://sync.example.com/workspaces/${encodeURIComponent(metadata.workspaceId)}/integrations/linkedin/relations/export?cutoff_date=2026-04-25`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns the helpful connect error when LinkedIn is not connected", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acrm-linkedin-import-"));
    const workspacePath = join(dir, "workspace.acrm");
    const ws = await Workspace.create(workspacePath);
    await ws.close();
    process.env.ACRM_SYNC_ENGINE_URL = "https://sync.example.com";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      ok: false,
      error: { code: "linkedin_not_connected" },
    }, { status: 409 })));

    try {
      await expect(
        linkedinCommandTest.runImportLinkedinNetwork({ workspace: workspacePath }),
      ).rejects.toMatchObject({
        message: LINKEDIN_NOT_CONNECTED_MESSAGE,
        code: ERR.INVALID_INPUT,
        hint: LINKEDIN_NOT_CONNECTED_HINT,
      } satisfies Partial<AcrmError>);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function singleValue(ws: Workspace, attributeSlug: string): Promise<string | null> {
  const result = await exec(
    ws.lix,
    `SELECT value_json
     FROM acrm_value
     WHERE object_slug = 'people'
       AND attribute_slug = $1
       AND active_until IS NULL
     LIMIT 1`,
    [attributeSlug],
  );
  const raw = result.rows[0]?.value_json;
  const parsed = typeof raw === "string" ? JSON.parse(raw) as { value?: string; timestamp?: string } : raw as { value?: string; timestamp?: string } | undefined;
  return parsed?.value ?? parsed?.timestamp ?? null;
}
