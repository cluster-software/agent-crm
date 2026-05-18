import { describe, expect, it } from "vitest";
import type { Lix } from "@lix-js/sdk";
import { openTestWorkspace } from "../test/open-test-lix.js";
import { exec, importCsv, Workspace } from "@agent-crm/sdk";

async function rowsForAttribute(
  lix: Lix,
  attribute_slug: string,
): Promise<Array<{ record_id: string; normalized_key: string | null }>> {
  const r = await exec(
    lix,
    `SELECT record_id, normalized_key FROM acrm_value
     WHERE object_slug = 'people' AND attribute_slug = $1
       AND active_until IS NULL
     ORDER BY normalized_key`,
    [attribute_slug],
  );
  return r.rows.map((row) => ({
    record_id: row.record_id as string,
    normalized_key: (row.normalized_key as string | null) ?? null,
  }));
}

describe("importCsv phone identifier", () => {
  it("creates a person from a row with only name + phone (no email/linkedin/twitter)", async () => {
    const lix = await openTestWorkspace();
    const csv = "name,phone\nAlice Phoneonly,+1 (415) 555-1234\n";
    const result = await importCsv(Workspace.fromLix(lix), {
      csvText: csv,
      source: "csv:test",
      default_country: "US",
    });
    expect(result.stats.people_created).toBe(1);
    expect(result.stats.people_skipped_no_identifier).toBe(0);
    const phones = await rowsForAttribute(lix, "phone_numbers");
    expect(phones).toHaveLength(1);
    expect(phones[0]?.normalized_key).toBe("+14155551234");
    await lix.close();
  });

  it("dedupes locally-formatted and +-prefixed phones under default_country=US", async () => {
    const lix = await openTestWorkspace();
    const csv =
      "name,phone\nAlice One,+1 (415) 555-1234\nAlice Two,(415) 555-1234\nAlice Three,1-415-555-1234\n";
    const result = await importCsv(Workspace.fromLix(lix), {
      csvText: csv,
      source: "csv:test",
      default_country: "US",
    });
    expect(result.stats.people_created).toBe(1);
    const phones = await rowsForAttribute(lix, "phone_numbers");
    expect(phones).toHaveLength(1);
    expect(phones[0]?.normalized_key).toBe("+14155551234");
    await lix.close();
  });

  it("parses +-prefixed non-US numbers independent of default_country", async () => {
    const lix = await openTestWorkspace();
    const csv = "name,phone\nLondon Lou,+44 20 7946 0958\n";
    const result = await importCsv(Workspace.fromLix(lix), {
      csvText: csv,
      source: "csv:test",
      default_country: "US",
    });
    expect(result.stats.people_created).toBe(1);
    const phones = await rowsForAttribute(lix, "phone_numbers");
    expect(phones[0]?.normalized_key).toBe("+442079460958");
    await lix.close();
  });

  it("recognizes work_phone[_N] and personal_phone columns and splits comma-separated values", async () => {
    const lix = await openTestWorkspace();
    const csv =
      "name,work_phone_1,personal_phone\nMulti Phone,+1 415 555 1111; +1 415 555 2222,(212) 555-3333\n";
    const result = await importCsv(Workspace.fromLix(lix), {
      csvText: csv,
      source: "csv:test",
      default_country: "US",
    });
    expect(result.stats.people_created).toBe(1);
    const phones = await rowsForAttribute(lix, "phone_numbers");
    expect(phones.map((p) => p.normalized_key).sort()).toEqual([
      "+14155551111",
      "+14155552222",
      "+12125553333",
    ].sort());
    await lix.close();
  });

  it("prefers email over phone for dedup when both match different people", async () => {
    const lix = await openTestWorkspace();
    const seed1 = "name,email\nEmail Person,alice@acme.com\n";
    const seed2 = "name,phone\nPhone Person,(415) 555-1234\n";
    await importCsv(Workspace.fromLix(lix), {
      csvText: seed1,
      source: "csv:t",
      default_country: "US",
    });
    await importCsv(Workspace.fromLix(lix), {
      csvText: seed2,
      source: "csv:t",
      default_country: "US",
    });

    // A row carrying both — email should win the cascade.
    const csv = "name,email,phone\nAlice,alice@acme.com,(415) 555-1234\n";
    const result = await importCsv(Workspace.fromLix(lix), {
      csvText: csv,
      source: "csv:test",
      default_country: "US",
    });
    expect(result.stats.people_created).toBe(0);
    await lix.close();
  });
});
