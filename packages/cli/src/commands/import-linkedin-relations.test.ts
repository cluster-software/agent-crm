import { describe, expect, it } from "vitest";
import {
  addMultiValue,
  exec,
  importLinkedinRelations,
  insertRecord,
  setSingleValue,
  Workspace,
  type LinkedinRelation,
} from "@agent-crm/sdk";
import { openTestWorkspace } from "../test/open-test-lix.js";

describe("importLinkedinRelations", () => {
  it("imports LinkedIn relation rows into people", async () => {
    const lix = await openTestWorkspace();
    const ws = Workspace.fromLix(lix);

    const result = await importLinkedinRelations(ws, {
      relations: [
        relation({
          member_id: "member-1",
          created_at: 1742051769000,
          first_name: "Ada",
          last_name: "Lovelace",
          headline: "Founder at Analytical Engines",
          public_identifier: "ada-lovelace",
          public_profile_url: "https://www.linkedin.com/in/ada-lovelace/",
          profile_picture_url: "https://media.example.com/ada.jpg",
        }),
      ],
    });

    expect(result.stats.people_created).toBe(1);
    await expect(valueFor(ws, "people", "linkedin_url")).resolves.toBe("linkedin.com/in/ada-lovelace");
    await expect(valueFor(ws, "people", "name")).resolves.toBe("Ada Lovelace");
    await expect(valueFor(ws, "people", "profile_picture_url")).resolves.toBe("https://media.example.com/ada.jpg");
    await expect(valueFor(ws, "people", "job_title")).resolves.toBe("Founder at Analytical Engines");
    await expect(valueFor(ws, "people", "linkedin_connected_at")).resolves.toBe("2025-03-15T15:16:09.000Z");
    await expect(countValues(ws, "source_keys")).resolves.toBe(1);
    await expect(countRecords(ws, "companies")).resolves.toBe(0);
    await expect(referenceCount(ws, "people", "company", "companies")).resolves.toBe(0);
    await lix.close();
  });

  it("imports companies from LinkedIn relation rows and links people", async () => {
    const lix = await openTestWorkspace();
    const ws = Workspace.fromLix(lix);

    const relations = [
      relation({
        member_id: "member-1",
        first_name: "Ada",
        last_name: "Lovelace",
        company_name: "Analytical Engines",
        company_linkedin_url: "https://www.linkedin.com/company/analytical-engines/",
        company_website: "https://www.analytical-engines.example/about",
        public_profile_url: "https://www.linkedin.com/in/ada-lovelace/",
      }),
    ];

    const result = await importLinkedinRelations(ws, { relations });
    const second = await importLinkedinRelations(ws, { relations });

    expect(result.stats.people_created).toBe(1);
    expect(result.stats.companies_created).toBe(1);
    expect(second.stats.people_created).toBe(0);
    expect(second.stats.companies_created).toBe(0);
    expect(second.stats.people_updated).toBe(0);
    expect(second.stats.companies_updated).toBe(0);
    await expect(valueFor(ws, "companies", "name")).resolves.toBe("Analytical Engines");
    await expect(valueFor(ws, "companies", "domains")).resolves.toBe("analytical-engines.example");
    await expect(valueFor(ws, "companies", "linkedin_url")).resolves.toBe("linkedin.com/company/analytical-engines");
    await expect(referenceCount(ws, "people", "company", "companies")).resolves.toBe(1);
    await expect(referenceCount(ws, "companies", "team", "people")).resolves.toBe(1);
    await lix.close();
  });

  it("is idempotent across repeated imports", async () => {
    const lix = await openTestWorkspace();
    const ws = Workspace.fromLix(lix);
    const relations = [
      relation({
        member_id: "member-1",
        first_name: "Ada",
        last_name: "Lovelace",
        public_profile_url: "https://www.linkedin.com/in/ada-lovelace/",
      }),
    ];

    const first = await importLinkedinRelations(ws, { relations });
    const valuesAfterFirstImport = await countAllValues(ws);
    const second = await importLinkedinRelations(ws, { relations });

    expect(first.stats.people_created).toBe(1);
    expect(second.stats.people_created).toBe(0);
    expect(second.stats.people_updated).toBe(0);
    await expect(countRecords(ws, "people")).resolves.toBe(1);
    await expect(countAllValues(ws)).resolves.toBe(valuesAfterFirstImport);
    await lix.close();
  });

  it("dedupes by LinkedIn URL before relation source key", async () => {
    const lix = await openTestWorkspace();
    const ws = Workspace.fromLix(lix);

    await importLinkedinRelations(ws, {
      relations: [
        relation({
          member_id: "member-1",
          first_name: "Ada",
          public_profile_url: "https://www.linkedin.com/in/ada-lovelace/",
        }),
        relation({
          member_id: "member-2",
          first_name: "Ada",
          public_profile_url: "https://linkedin.com/in/ada-lovelace",
        }),
      ],
    });

    await expect(countRecords(ws, "people")).resolves.toBe(1);
    await expect(countValues(ws, "source_keys")).resolves.toBe(2);
    await lix.close();
  });

  it("does not overwrite richer existing person fields", async () => {
    const lix = await openTestWorkspace();
    const ws = Workspace.fromLix(lix);
    const personId = "person-existing";
    await insertRecord(lix, "people", personId);
    await addMultiValue(lix, {
      object_slug: "people",
      record_id: personId,
      attribute_slug: "source_keys",
      attribute_type: "text",
      value: "csv:ada",
      source: "test",
      provenance: {},
    });
    await setSingleValue(lix, {
      object_slug: "people",
      record_id: personId,
      attribute_slug: "linkedin_url",
      attribute_type: "url",
      value: "linkedin.com/in/ada-lovelace",
      source: "test",
      provenance: {},
    });
    await setSingleValue(lix, {
      object_slug: "people",
      record_id: personId,
      attribute_slug: "name",
      attribute_type: "personal-name",
      value: "Augusta Ada King",
      source: "test",
      provenance: {},
    });
    await setSingleValue(lix, {
      object_slug: "people",
      record_id: personId,
      attribute_slug: "job_title",
      attribute_type: "text",
      value: "Mathematician",
      source: "test",
      provenance: {},
    });

    const result = await importLinkedinRelations(ws, {
      relations: [
        relation({
          member_id: "member-1",
          created_at: 1742051769000,
          first_name: "Ada",
          last_name: "Lovelace",
          headline: "Founder at Analytical Engines",
          public_profile_url: "https://www.linkedin.com/in/ada-lovelace/",
        }),
      ],
    });

    expect(result.stats.people_created).toBe(0);
    await expect(valueFor(ws, "people", "name")).resolves.toBe("Augusta Ada King");
    await expect(valueFor(ws, "people", "job_title")).resolves.toBe("Mathematician");
    await expect(valueFor(ws, "people", "linkedin_connected_at")).resolves.toBe("2025-03-15T15:16:09.000Z");
    await expect(countValues(ws, "source_keys")).resolves.toBe(2);
    await lix.close();
  });
});

function relation(overrides: Partial<LinkedinRelation>): LinkedinRelation {
  return {
    object: "UserRelation",
    connection_urn: "urn:li:fsd_connection:member-1",
    member_id: "member-1",
    member_urn: "urn:li:fsd_profile:member-1",
    ...overrides,
  };
}

async function valueFor(ws: Workspace, objectSlug: string, attributeSlug: string): Promise<string | null> {
  const result = await exec(
    ws.lix,
    `SELECT value_json
     FROM acrm_value
     WHERE object_slug = $1
       AND attribute_slug = $2
       AND active_until IS NULL
     ORDER BY active_from DESC
     LIMIT 1`,
    [objectSlug, attributeSlug],
  );
  const raw = result.rows[0]?.value_json;
  const parsed = typeof raw === "string"
    ? JSON.parse(raw) as { value?: string; full_name?: string; timestamp?: string; domain?: string }
    : raw as { value?: string; full_name?: string; timestamp?: string; domain?: string } | undefined;
  return parsed?.value ?? parsed?.full_name ?? parsed?.timestamp ?? parsed?.domain ?? null;
}

async function referenceCount(
  ws: Workspace,
  objectSlug: string,
  attributeSlug: string,
  refObject: string,
): Promise<number> {
  const result = await exec(
    ws.lix,
    `SELECT COUNT(*) AS n
     FROM acrm_value
     WHERE object_slug = $1
       AND attribute_slug = $2
       AND ref_object = $3
       AND active_until IS NULL`,
    [objectSlug, attributeSlug, refObject],
  );
  return Number(result.rows[0]?.n ?? 0);
}

async function countRecords(ws: Workspace, objectSlug: string): Promise<number> {
  const result = await exec(
    ws.lix,
    "SELECT COUNT(*) AS n FROM acrm_record WHERE object_slug = $1",
    [objectSlug],
  );
  return Number(result.rows[0]?.n ?? 0);
}

async function countValues(ws: Workspace, attributeSlug: string): Promise<number> {
  const result = await exec(
    ws.lix,
    `SELECT COUNT(*) AS n
     FROM acrm_value
     WHERE object_slug = 'people'
       AND attribute_slug = $1
       AND active_until IS NULL`,
    [attributeSlug],
  );
  return Number(result.rows[0]?.n ?? 0);
}

async function countAllValues(ws: Workspace): Promise<number> {
  const result = await exec(
    ws.lix,
    "SELECT COUNT(*) AS n FROM acrm_value WHERE active_until IS NULL",
  );
  return Number(result.rows[0]?.n ?? 0);
}
