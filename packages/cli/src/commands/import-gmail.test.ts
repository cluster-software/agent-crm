import { afterEach, describe, expect, it, vi } from "vitest";
import { openTestWorkspace } from "../test/open-test-db.js";
import {
  exec,
  importGoogleContacts,
  Workspace,
  type GoogleContact,
} from "@agent-crm/sdk";
import { __test as gmailCommandTest } from "./import-gmail.js";

const TEST_DATABASE_URL = "postgres://user:pass@localhost/acrm_test";

async function rowsFor(
  ws: Workspace,
  object_slug: string,
  attribute_slug: string,
) {
  const r = await exec(
    ws.db,
    `SELECT record_id, normalized_key, value_json FROM acrm_value
     WHERE object_slug = $1 AND attribute_slug = $2 AND active_until IS NULL
     ORDER BY normalized_key`,
    [object_slug, attribute_slug],
  );
  return r.rows.map((row) => ({
    record_id: row.record_id as string,
    normalized_key: (row.normalized_key as string | null) ?? null,
    value_json: row.value_json,
  }));
}

describe("importGoogleContacts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("builds a hosted sync-engine Gmail OAuth URL", () => {
    const url = gmailCommandTest.gmailConnectUrl({
      syncEngineUrl: "https://sync.example.com",
      workspaceId: "workspace-1",
      orgId: "org-1",
      workspaceName: "pipeline",
    });

    expect(url).toBe(
      "https://sync.example.com/integrations/gmail/connect?workspace_id=workspace-1&org_id=org-1&workspace_name=pipeline",
    );
  });

  it("omits Cluster org id when browser auth should infer it", () => {
    const url = gmailCommandTest.gmailConnectUrl({
      syncEngineUrl: "https://sync.example.com",
      workspaceId: "workspace-1",
      workspaceName: "pipeline",
    });

    expect(url).toBe(
      "https://sync.example.com/integrations/gmail/connect?workspace_id=workspace-1&workspace_name=pipeline",
    );
  });

  it("adds Gmail sync preferences to the hosted OAuth URL", () => {
    const url = gmailCommandTest.gmailConnectUrl({
      syncEngineUrl: "https://sync.example.com",
      workspaceId: "workspace-1",
      orgId: "org-1",
      workspaceName: "pipeline",
      backfillDays: 30,
      excludeNewsletters: true,
    });

    expect(url).toBe(
      "https://sync.example.com/integrations/gmail/connect?workspace_id=workspace-1&org_id=org-1&workspace_name=pipeline&backfill_days=30&exclude_newsletters=true",
    );
  });

  it("validates Gmail sync preference flags", () => {
    expect(gmailCommandTest.parseGmailSyncPreferences({
      backfillDays: "90",
      includeNewsletters: true,
    })).toEqual({
      backfillDays: 90,
      excludeNewsletters: false,
    });
    expect(gmailCommandTest.parseGmailSyncPreferences({
      backfillSince: "2026-01-01",
      excludeNewsletters: true,
    })).toEqual({
      backfillSince: "2026-01-01",
      excludeNewsletters: true,
    });

    expect(() => gmailCommandTest.parseGmailSyncPreferences({
      backfillDays: "30",
      backfillSince: "2026-01-01",
    })).toThrow(/cannot be used together/);
    expect(() => gmailCommandTest.parseGmailSyncPreferences({
      backfillDays: "60",
    })).toThrow(/must be 30 or 90/);
    expect(() => gmailCommandTest.parseGmailSyncPreferences({
      backfillSince: "2026-02-31",
    })).toThrow(/valid calendar date/);
    expect(() => gmailCommandTest.parseGmailSyncPreferences({
      excludeNewsletters: true,
      includeNewsletters: true,
    })).toThrow(/cannot be used together/);
  });

  it("selects the platform browser opener command", () => {
    expect(gmailCommandTest.browserOpenCommand("darwin", "https://example.com")).toEqual({
      command: "open",
      args: ["https://example.com"],
    });
    expect(gmailCommandTest.browserOpenCommand("win32", "https://example.com")).toEqual({
      command: "cmd",
      args: ["/c", "start", "", "https://example.com"],
    });
    expect(gmailCommandTest.browserOpenCommand("linux", "https://example.com")).toEqual({
      command: "xdg-open",
      args: ["https://example.com"],
    });
  });

  it("uses a desktop cloud session to add a browser handoff to the Gmail URL", async () => {
    vi.stubEnv("ACRM_SYNC_ENGINE_URL", "https://sync.example.com");
    vi.stubEnv("ACRM_CLOUD_WORKSPACE_ID", "workspace-1");
    vi.stubEnv("ACRM_CLOUD_ORG_ID", "org-1");
    vi.stubEnv("ACRM_DESKTOP_SESSION_TOKEN", "desktop-token");
    const fetchMock = vi.fn(async () => Response.json({
      ok: true,
      code: "handoff-1",
      expires_at: "2026-06-01T00:05:00.000Z",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await gmailCommandTest.runImportGmail({
      workspaceName: "pipeline",
    });
    const authUrl = new URL(result.auth_url);

    expect(result.workspace_id).toBe("workspace-1");
    expect(result.org_id).toBe("org-1");
    expect(authUrl.searchParams.get("org_id")).toBe("org-1");
    expect(new URLSearchParams(authUrl.hash.slice(1)).get("auth_handoff")).toBe("handoff-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [handoffUrl, handoffInit] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(handoffUrl.toString()).toBe("https://sync.example.com/auth/browser-handoffs");
    expect(handoffInit).toEqual({
      method: "POST",
      headers: {
        authorization: "Bearer desktop-token",
        accept: "application/json",
      },
    });
  });

  it("rejects an org override that does not match the desktop session", async () => {
    vi.stubEnv("ACRM_SYNC_ENGINE_URL", "https://sync.example.com");
    vi.stubEnv("ACRM_CLOUD_WORKSPACE_ID", "workspace-1");
    vi.stubEnv("ACRM_CLOUD_ORG_ID", "org-1");
    vi.stubEnv("ACRM_DESKTOP_SESSION_TOKEN", "desktop-token");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(gmailCommandTest.runImportGmail({
      workspaceName: "pipeline",
      orgId: "org-2",
    })).rejects.toThrow(/does not match the active desktop session org/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("registers the cloud workspace and returns a hosted Gmail browser URL", async () => {
    const db = await openTestWorkspace();
    vi.stubEnv("ACRM_SYNC_ENGINE_URL", "https://sync.example.com");
    vi.stubEnv("ACRM_CLOUD_WORKSPACE_ID", "workspace-1");
    vi.stubEnv("ACRM_CLOUD_WORKSPACE_CLIENT_TOKEN", "client-token-1");
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await gmailCommandTest.runImportGmail({
        workspace: TEST_DATABASE_URL,
        db,
        workspaceName: "pipeline",
        orgId: "org-1",
      });
      const authUrl = new URL(result.auth_url);

      expect(result.workspace_id).toBe("workspace-1");
      expect(result.org_id).toBe("org-1");
      expect(result.cluster_org_id).toBe("org-1");
      expect(result.sync_engine_url).toBe("https://sync.example.com");
      expect(authUrl.origin + authUrl.pathname).toBe("https://sync.example.com/integrations/gmail/connect");
      expect(authUrl.searchParams.get("workspace_id")).toBe("workspace-1");
      expect(authUrl.searchParams.get("org_id")).toBe("org-1");
      expect(authUrl.searchParams.get("workspace_name")).toBe("pipeline");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [registerUrl, registerInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      const parsedRegisterUrl = new URL(registerUrl);
      expect(parsedRegisterUrl.origin + parsedRegisterUrl.pathname).toBe("https://sync.example.com/workspaces/workspace-1/register");
      expect(parsedRegisterUrl.searchParams.get("workspace_name")).toBe("pipeline");
      expect(registerInit).toEqual({
        method: "POST",
        headers: {
          authorization: "Bearer client-token-1",
        },
      });
    } finally {
      await db.close();
    }
  });

  it("creates person + company from a connection with email + organization", async () => {
    const db = await openTestWorkspace();
    const ws = Workspace.fromDatabase(db);
    const contacts: GoogleContact[] = [
      {
        resource_name: "people/c1",
        origin: "connections",
        display_name: "Jane Doe",
        emails: ["jane@acme.com"],
        organizations: [{ name: "Acme Corp", title: "VP Sales" }],
      },
    ];
    const result = await importGoogleContacts(ws, { contacts });
    expect(result.stats.people_created).toBe(1);
    expect(result.stats.companies_created).toBe(1);
    const emails = await rowsFor(ws, "people", "email_addresses");
    expect(emails).toHaveLength(1);
    expect(emails[0]?.normalized_key).toBe("jane@acme.com");
    const domains = await rowsFor(ws, "companies", "domains");
    expect(domains).toHaveLength(1);
    expect(domains[0]?.normalized_key).toBe("acme.com");
    const names = await rowsFor(ws, "people", "name");
    expect(names).toHaveLength(1);
    const titles = await rowsFor(ws, "people", "job_title");
    expect(titles).toHaveLength(1);
    await db.close();
  });

  it("dedupes a contact that already exists via CSV by email", async () => {
    const db = await openTestWorkspace();
    const ws = Workspace.fromDatabase(db);
    const first: GoogleContact[] = [
      {
        resource_name: "people/c1",
        origin: "connections",
        display_name: "Jane Doe",
        emails: ["jane@acme.com"],
      },
    ];
    await importGoogleContacts(ws, { contacts: first });
    const result = await importGoogleContacts(ws, {
      contacts: [
        {
          resource_name: "people/c1",
          origin: "connections",
          display_name: "Jane D.",
          emails: ["jane@acme.com"],
        },
      ],
    });
    expect(result.stats.people_created).toBe(0);
    const emails = await rowsFor(ws, "people", "email_addresses");
    expect(emails).toHaveLength(1);
    await db.close();
  });

  it("skips a contact with only a display name (no identifier)", async () => {
    const db = await openTestWorkspace();
    const ws = Workspace.fromDatabase(db);
    const result = await importGoogleContacts(ws, {
      contacts: [
        {
          resource_name: "people/c-empty",
          origin: "connections",
          display_name: "Nameonly McNobody",
        },
      ],
    });
    expect(result.stats.people_created).toBe(0);
    expect(result.stats.people_skipped_no_identifier).toBe(1);
    await db.close();
  });

  it("classifies linkedin + x URLs from the contact card", async () => {
    const db = await openTestWorkspace();
    const ws = Workspace.fromDatabase(db);
    await importGoogleContacts(ws, {
      contacts: [
        {
          resource_name: "people/c2",
          origin: "connections",
          display_name: "Linked Larry",
          emails: ["larry@example.com"],
          urls: [
            "https://www.linkedin.com/in/larry",
            "https://x.com/larry",
            "https://example.com",
          ],
        },
      ],
    });
    const li = await rowsFor(ws, "people", "linkedin_url");
    expect(li).toHaveLength(1);
    expect(li[0]?.normalized_key).toBe("linkedin.com/in/larry");
    const x = await rowsFor(ws, "people", "twitter_url");
    expect(x).toHaveLength(1);
    expect(x[0]?.normalized_key).toBe("x.com/larry");
    await db.close();
  });

  it("links an existing person (matched by linkedin) to the company discovered on re-import", async () => {
    const db = await openTestWorkspace();
    const ws = Workspace.fromDatabase(db);

    // First import: linkedin-only contact. No email → no company.
    await importGoogleContacts(ws, {
      contacts: [
        {
          resource_name: "people/linkedin-only",
          origin: "connections",
          display_name: "Jane Doe",
          urls: ["https://www.linkedin.com/in/janedoe"],
        },
      ],
    });
    expect(
      (await rowsFor(ws, "companies", "domains")).length,
      "no company before second import",
    ).toBe(0);
    expect(
      (await rowsFor(ws, "people", "company")).length,
      "no person→company link before second import",
    ).toBe(0);

    // Second import: matches by linkedin URL. Now has email (→ company
    // domain) and organization name. The existing person should gain a
    // company ref even though personCreated === false.
    const result = await importGoogleContacts(ws, {
      contacts: [
        {
          resource_name: "people/enriched",
          origin: "connections",
          display_name: "Jane Doe",
          emails: ["jane@acme.com"],
          urls: ["https://www.linkedin.com/in/janedoe"],
          organizations: [{ name: "Acme Corp", title: "VP Sales" }],
        },
      ],
    });
    expect(
      result.stats.people_created,
      "matched existing person via linkedin_url",
    ).toBe(0);
    expect(result.stats.companies_created).toBe(1);
    const companyLinks = await rowsFor(ws, "people", "company");
    expect(
      companyLinks,
      "fix: existing person now linked to the company",
    ).toHaveLength(1);
    await db.close();
  });

  it("dedupes companies across two contacts that share a domain", async () => {
    const db = await openTestWorkspace();
    const ws = Workspace.fromDatabase(db);
    const result = await importGoogleContacts(ws, {
      contacts: [
        {
          resource_name: "people/c-a",
          origin: "connections",
          display_name: "Alice",
          emails: ["alice@acme.com"],
        },
        {
          resource_name: "people/c-b",
          origin: "other_contacts",
          display_name: "Bob",
          emails: ["bob@acme.com"],
        },
      ],
    });
    expect(result.stats.people_created).toBe(2);
    expect(result.stats.companies_created).toBe(1);
    const domains = await rowsFor(ws, "companies", "domains");
    expect(domains).toHaveLength(1);
    expect(domains[0]?.normalized_key).toBe("acme.com");
    await db.close();
  });
});
