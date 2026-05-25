import { describe, expect, it } from "vitest";
import { openTestWorkspace } from "../test/open-test-lix.js";
import {
  exec,
  importGoogleContacts,
  Workspace,
  type GoogleContact,
} from "@agent-crm/sdk";
import { __test as gmailCommandTest } from "./import-gmail.js";

async function rowsFor(
  ws: Workspace,
  object_slug: string,
  attribute_slug: string,
) {
  const r = await exec(
    ws.lix,
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
  it("builds a hosted sync-engine Gmail OAuth URL", () => {
    const url = gmailCommandTest.gmailConnectUrl({
      syncEngineUrl: "https://sync.example.com",
      workspaceId: "workspace-1",
      workspaceName: "pipeline",
    });

    expect(url).toBe(
      "https://sync.example.com/integrations/gmail/connect?workspace_id=workspace-1&workspace_name=pipeline",
    );
  });

  it("creates person + company from a connection with email + organization", async () => {
    const lix = await openTestWorkspace();
    const ws = Workspace.fromLix(lix);
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
    await lix.close();
  });

  it("dedupes a contact that already exists via CSV by email", async () => {
    const lix = await openTestWorkspace();
    const ws = Workspace.fromLix(lix);
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
    await lix.close();
  });

  it("skips a contact with only a display name (no identifier)", async () => {
    const lix = await openTestWorkspace();
    const ws = Workspace.fromLix(lix);
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
    await lix.close();
  });

  it("classifies linkedin + x URLs from the contact card", async () => {
    const lix = await openTestWorkspace();
    const ws = Workspace.fromLix(lix);
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
    await lix.close();
  });

  it("links an existing person (matched by linkedin) to the company discovered on re-import", async () => {
    const lix = await openTestWorkspace();
    const ws = Workspace.fromLix(lix);

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
    await lix.close();
  });

  it("dedupes companies across two contacts that share a domain", async () => {
    const lix = await openTestWorkspace();
    const ws = Workspace.fromLix(lix);
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
    await lix.close();
  });
});
