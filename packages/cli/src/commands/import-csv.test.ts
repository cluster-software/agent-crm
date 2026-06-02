import { describe, expect, it } from "vitest";
import type { AcrmDatabase } from "@agent-crm/sdk";
import { openTestWorkspace } from "../test/open-test-db.js";
import { importCsv, Workspace } from "@agent-crm/sdk";
import { exec } from "../../../sdk/src/db/execute.js";

async function rowsForAttribute(
  db: AcrmDatabase,
  attribute_slug: string,
): Promise<Array<{ record_id: string; normalized_key: string | null }>> {
  const r = await exec(
    db,
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
    const db = await openTestWorkspace();
    const csv = "name,phone\nAlice Phoneonly,+1 (415) 555-1234\n";
    const result = await importCsv(Workspace.fromDatabase(db), {
      csvText: csv,
      source: "csv:test",
      default_country: "US",
    });
    expect(result.stats.people_created).toBe(1);
    expect(result.stats.people_skipped_no_identifier).toBe(0);
    const phones = await rowsForAttribute(db, "phone_numbers");
    expect(phones).toHaveLength(1);
    expect(phones[0]?.normalized_key).toBe("+14155551234");
    await db.close();
  });

  it("returns touched people and companies for post-import signal runs", async () => {
    const db = await openTestWorkspace();
    const csv = "name,email,company,domain\nAlice Signal,alice@hotel.example,Hotel Signal,hotel.example\n";
    const result = await importCsv(Workspace.fromDatabase(db), {
      csvText: csv,
      source: "csv:test",
      default_country: "US",
    });
    expect(result.touched_records.map((record) => record.object_slug).sort()).toEqual([
      "companies",
      "people",
    ]);
    await db.close();
  });

  it("dedupes repeated company domains while importing rows concurrently", async () => {
    const db = await openTestWorkspace();
    const csv =
      "name,email,company,domain\n" +
      Array.from(
        { length: 20 },
        (_, i) => `Hotel Person ${i},person${i}@hotel.example,Hotel Concurrent,hotel.example`,
      ).join("\n") +
      "\n";
    const result = await importCsv(Workspace.fromDatabase(db), {
      csvText: csv,
      source: "csv:test",
      default_country: "US",
      concurrency: 10,
    });
    expect(result.stats.companies_created).toBe(1);
    expect(result.stats.people_created).toBe(20);
    const companies = await exec(
      db,
      "SELECT COUNT(*) AS n FROM acrm_record WHERE object_slug = 'companies'",
    );
    expect(companies.rows[0]?.n).toBe(1);
    await db.close();
  });

  it("dedupes locally-formatted and +-prefixed phones under default_country=US", async () => {
    const db = await openTestWorkspace();
    const csv =
      "name,phone\nAlice One,+1 (415) 555-1234\nAlice Two,(415) 555-1234\nAlice Three,1-415-555-1234\n";
    const result = await importCsv(Workspace.fromDatabase(db), {
      csvText: csv,
      source: "csv:test",
      default_country: "US",
    });
    expect(result.stats.people_created).toBe(1);
    const phones = await rowsForAttribute(db, "phone_numbers");
    expect(phones).toHaveLength(1);
    expect(phones[0]?.normalized_key).toBe("+14155551234");
    await db.close();
  });

  it("parses +-prefixed non-US numbers independent of default_country", async () => {
    const db = await openTestWorkspace();
    const csv = "name,phone\nLondon Lou,+44 20 7946 0958\n";
    const result = await importCsv(Workspace.fromDatabase(db), {
      csvText: csv,
      source: "csv:test",
      default_country: "US",
    });
    expect(result.stats.people_created).toBe(1);
    const phones = await rowsForAttribute(db, "phone_numbers");
    expect(phones[0]?.normalized_key).toBe("+442079460958");
    await db.close();
  });

  it("recognizes work_phone[_N] and personal_phone columns and splits comma-separated values", async () => {
    const db = await openTestWorkspace();
    const csv =
      "name,work_phone_1,personal_phone\nMulti Phone,+1 415 555 1111; +1 415 555 2222,(212) 555-3333\n";
    const result = await importCsv(Workspace.fromDatabase(db), {
      csvText: csv,
      source: "csv:test",
      default_country: "US",
    });
    expect(result.stats.people_created).toBe(1);
    const phones = await rowsForAttribute(db, "phone_numbers");
    expect(phones.map((p) => p.normalized_key).sort()).toEqual([
      "+14155551111",
      "+14155552222",
      "+12125553333",
    ].sort());
    await db.close();
  });

  it("prefers email over phone for dedup when both match different people", async () => {
    const db = await openTestWorkspace();
    const seed1 = "name,email\nEmail Person,alice@acme.com\n";
    const seed2 = "name,phone\nPhone Person,(415) 555-1234\n";
    await importCsv(Workspace.fromDatabase(db), {
      csvText: seed1,
      source: "csv:t",
      default_country: "US",
    });
    await importCsv(Workspace.fromDatabase(db), {
      csvText: seed2,
      source: "csv:t",
      default_country: "US",
    });

    // A row carrying both — email should win the cascade.
    const csv = "name,email,phone\nAlice,alice@acme.com,(415) 555-1234\n";
    const result = await importCsv(Workspace.fromDatabase(db), {
      csvText: csv,
      source: "csv:test",
      default_country: "US",
    });
    expect(result.stats.people_created).toBe(0);
    await db.close();
  });
});
