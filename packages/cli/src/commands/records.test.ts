import { describe, expect, it } from "vitest";
import type { AcrmDatabase } from "@agent-crm/sdk";
import { openTestWorkspace } from "../test/open-test-db.js";
import { exec } from "../../../sdk/src/db/execute.js";
import {
  addMultiValue,
  insertRecord,
  setSingleValue,
} from "../../../sdk/src/db/upsert.js";
import { generateUuid } from "@agent-crm/sdk";
import { dedupeRecords, importTranscript, Workspace } from "@agent-crm/sdk";

async function seedPerson(
  db: AcrmDatabase,
  spec: {
    email?: string;
    emails?: string[];
    linkedin_url?: string;
    twitter_url?: string;
    name?: string;
    job_title?: string;
  },
): Promise<string> {
  const id = await generateUuid(db);
  await insertRecord(db, "people", id);
  const source = "test";
  const provenance = { test: true };
  const emails = [...(spec.emails ?? []), ...(spec.email ? [spec.email] : [])];
  for (const e of emails) {
    await addMultiValue(db, {
      object_slug: "people",
      record_id: id,
      attribute_slug: "email_addresses",
      attribute_type: "email-address",
      value: e,
      source,
      provenance,
    });
  }
  if (spec.linkedin_url) {
    await setSingleValue(db, {
      object_slug: "people",
      record_id: id,
      attribute_slug: "linkedin_url",
      attribute_type: "url",
      value: spec.linkedin_url,
      source,
      provenance,
    });
  }
  if (spec.twitter_url) {
    await setSingleValue(db, {
      object_slug: "people",
      record_id: id,
      attribute_slug: "twitter_url",
      attribute_type: "url",
      value: spec.twitter_url,
      source,
      provenance,
    });
  }
  if (spec.name) {
    await setSingleValue(db, {
      object_slug: "people",
      record_id: id,
      attribute_slug: "name",
      attribute_type: "personal-name",
      value: spec.name,
      source,
      provenance,
    });
  }
  if (spec.job_title) {
    await setSingleValue(db, {
      object_slug: "people",
      record_id: id,
      attribute_slug: "job_title",
      attribute_type: "text",
      value: spec.job_title,
      source,
      provenance,
    });
  }
  return id;
}

async function emailsFor(db: AcrmDatabase, personId: string): Promise<string[]> {
  const r = await exec(
    db,
    `SELECT normalized_key FROM acrm_value
     WHERE object_slug = 'people' AND record_id = $1
       AND attribute_slug = 'email_addresses' AND active_until IS NULL
     ORDER BY normalized_key`,
    [personId],
  );
  return r.rows.map((row) => row.normalized_key as string);
}

async function singleValueFor(
  db: AcrmDatabase,
  personId: string,
  attribute_slug: string,
): Promise<string | null> {
  const r = await exec(
    db,
    `SELECT normalized_key, value_json FROM acrm_value
     WHERE object_slug = 'people' AND record_id = $1
       AND attribute_slug = $2 AND active_until IS NULL
     LIMIT 1`,
    [personId, attribute_slug],
  );
  return (
    (r.rows[0]?.normalized_key as string | undefined) ??
    (r.rows[0]?.value_json as string | undefined) ??
    null
  );
}

async function recordExists(
  db: AcrmDatabase,
  object_slug: string,
  record_id: string,
): Promise<boolean> {
  const r = await exec(
    db,
    `SELECT 1 FROM acrm_record WHERE object_slug = $1 AND record_id = $2`,
    [object_slug, record_id],
  );
  return r.rows.length > 0;
}

describe("dedupeRecords", () => {
  it("reassigns multivalued values and dedupes by normalized_key", async () => {
    const db = await openTestWorkspace();
    const keep = await seedPerson(db, {
      emails: ["alice@acme.com"],
      name: "Alice",
    });
    const discard = await seedPerson(db, {
      emails: ["alice@acme.com", "alice.b@acme.com"],
    });

    const result = await dedupeRecords(Workspace.fromDatabase(db), {
      object_slug: "people",
      keep_record_id: keep,
      discard_record_id: discard,
      prefer: "keep",
      dryRun: false,
    });

    expect(result.applied).toBe(true);
    expect(result.discard_record_deleted).toBe(true);
    expect(await recordExists(db, "people", discard)).toBe(false);

    // Keeper has both emails, deduped.
    expect(await emailsFor(db, keep)).toEqual([
      "alice.b@acme.com",
      "alice@acme.com",
    ]);
    await db.close();
  });

  it("moves single-valued attributes when keeper is empty", async () => {
    const db = await openTestWorkspace();
    const keep = await seedPerson(db, { email: "luis@cluster.com" });
    const discard = await seedPerson(db, {
      linkedin_url: "linkedin.com/in/luis",
      job_title: "Founder",
    });

    await dedupeRecords(Workspace.fromDatabase(db), {
      object_slug: "people",
      keep_record_id: keep,
      discard_record_id: discard,
      prefer: "keep",
      dryRun: false,
    });

    expect(await singleValueFor(db, keep, "linkedin_url")).toBe(
      "linkedin.com/in/luis",
    );
    const titleRow = await exec(
      db,
      `SELECT value_json FROM acrm_value
       WHERE object_slug='people' AND record_id=$1
         AND attribute_slug='job_title' AND active_until IS NULL`,
      [keep],
    );
    expect(JSON.stringify(titleRow.rows[0]?.value_json)).toContain("Founder");
    await db.close();
  });

  it("--prefer keep drops discard's single-value on conflict", async () => {
    const db = await openTestWorkspace();
    const keep = await seedPerson(db, {
      linkedin_url: "linkedin.com/in/keep",
    });
    const discard = await seedPerson(db, {
      linkedin_url: "linkedin.com/in/discard",
    });

    const result = await dedupeRecords(Workspace.fromDatabase(db), {
      object_slug: "people",
      keep_record_id: keep,
      discard_record_id: discard,
      prefer: "keep",
      dryRun: false,
    });

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.attribute_slug).toBe("linkedin_url");
    expect(result.conflicts[0]?.resolution).toBe("keep");
    expect(await singleValueFor(db, keep, "linkedin_url")).toBe(
      "linkedin.com/in/keep",
    );
    await db.close();
  });

  it("--prefer discard replaces keeper's single-value", async () => {
    const db = await openTestWorkspace();
    const keep = await seedPerson(db, {
      linkedin_url: "linkedin.com/in/keep",
    });
    const discard = await seedPerson(db, {
      linkedin_url: "linkedin.com/in/discard",
    });

    await dedupeRecords(Workspace.fromDatabase(db), {
      object_slug: "people",
      keep_record_id: keep,
      discard_record_id: discard,
      prefer: "discard",
      dryRun: false,
    });

    expect(await singleValueFor(db, keep, "linkedin_url")).toBe(
      "linkedin.com/in/discard",
    );
    await db.close();
  });

  it("redirects inbound record-references (transcripts.participants) to the keeper", async () => {
    const db = await openTestWorkspace();
    const keep = await seedPerson(db, {
      linkedin_url: "linkedin.com/in/luis",
    });
    const discard = await seedPerson(db, { email: "luis@cluster.com" });

    // Import a transcript that points at the discard via email.
    await importTranscript(Workspace.fromDatabase(db), {
      source: "granola",
      source_id: "meeting-1",
      title: "T",
      participants: [{ email: "luis@cluster.com" }],
    });

    // Sanity: the transcript references the discard, not the keeper.
    const before = await exec(
      db,
      `SELECT ref_record_id FROM acrm_value
       WHERE object_slug='transcripts' AND attribute_slug='participants'
         AND active_until IS NULL`,
    );
    expect(before.rows[0]?.ref_record_id).toBe(discard);

    await dedupeRecords(Workspace.fromDatabase(db), {
      object_slug: "people",
      keep_record_id: keep,
      discard_record_id: discard,
      prefer: "keep",
      dryRun: false,
    });

    // Forward link now points at the keeper.
    const after = await exec(
      db,
      `SELECT ref_record_id, value_json FROM acrm_value
       WHERE object_slug='transcripts' AND attribute_slug='participants'
         AND active_until IS NULL`,
    );
    expect(after.rows[0]?.ref_record_id).toBe(keep);
    expect(JSON.stringify(after.rows[0]?.value_json)).toContain(keep);

    // Inverse link (people.associated_transcripts) was on the discard;
    // gets moved to the keeper as one of its own multivalued rows.
    const inv = await exec(
      db,
      `SELECT record_id FROM acrm_value
       WHERE object_slug='people' AND attribute_slug='associated_transcripts'
         AND active_until IS NULL`,
    );
    expect(inv.rows[0]?.record_id).toBe(keep);

    // The discard record is gone.
    expect(await recordExists(db, "people", discard)).toBe(false);
    await db.close();
  });

  it("--dry-run reports the plan without mutating", async () => {
    const db = await openTestWorkspace();
    const keep = await seedPerson(db, {
      linkedin_url: "linkedin.com/in/luis",
    });
    const discard = await seedPerson(db, { email: "luis@cluster.com" });

    const plan = await dedupeRecords(Workspace.fromDatabase(db), {
      object_slug: "people",
      keep_record_id: keep,
      discard_record_id: discard,
      prefer: "keep",
      dryRun: true,
    });

    expect(plan.applied).toBe(false);
    expect(plan.discard_record_deleted).toBe(false);
    expect(plan.items.length).toBeGreaterThan(0);
    expect(await recordExists(db, "people", discard)).toBe(true);
    expect(await emailsFor(db, keep)).toEqual([]);
    await db.close();
  });

  it("rejects merging a record with itself", async () => {
    const db = await openTestWorkspace();
    const id = await seedPerson(db, { email: "a@b.com" });
    await expect(
      dedupeRecords(Workspace.fromDatabase(db), {
        object_slug: "people",
        keep_record_id: id,
        discard_record_id: id,
        prefer: "keep",
        dryRun: false,
      }),
    ).rejects.toThrow(/same record_id/);
    await db.close();
  });

  it("rejects unknown keep / discard record_ids", async () => {
    const db = await openTestWorkspace();
    const id = await seedPerson(db, { email: "a@b.com" });
    await expect(
      dedupeRecords(Workspace.fromDatabase(db), {
        object_slug: "people",
        keep_record_id: id,
        discard_record_id: "does-not-exist",
        prefer: "keep",
        dryRun: false,
      }),
    ).rejects.toThrow(/discard record_id not found/);
    await db.close();
  });

  it("end-to-end: reproduces the Luis duplicate scenario from the RCA", async () => {
    const db = await openTestWorkspace();
    // Luis #1: created by `acrm import linkedin` — has LinkedIn, no email.
    const luis1 = await seedPerson(db, {
      linkedin_url: "linkedin.com/in/luis-costa-laveron-834b05177",
      name: "Luis Costa Laveron",
      job_title: "Founder",
    });
    // Luis #2: created by `acrm import transcript` from an email-only
    // participant before the resolver could bridge identifier sets.
    const luis2 = await seedPerson(db, { email: "luis@hello-cluster.com" });

    // Transcript was imported pointing at luis2.
    await importTranscript(Workspace.fromDatabase(db), {
      source: "granola",
      source_id: "meeting-luis",
      title: "Discovery — Luis",
      participants: [{ email: "luis@hello-cluster.com" }],
    });

    const result = await dedupeRecords(Workspace.fromDatabase(db), {
      object_slug: "people",
      keep_record_id: luis1,
      discard_record_id: luis2,
      prefer: "keep",
      dryRun: false,
    });

    expect(result.applied).toBe(true);
    expect(await recordExists(db, "people", luis2)).toBe(false);
    expect(await emailsFor(db, luis1)).toEqual(["luis@hello-cluster.com"]);
    expect(await singleValueFor(db, luis1, "linkedin_url")).toBe(
      "linkedin.com/in/luis-costa-laveron-834b05177",
    );

    // Transcript now references the kept Luis.
    const refs = await exec(
      db,
      `SELECT ref_record_id FROM acrm_value
       WHERE object_slug='transcripts' AND attribute_slug='participants'
         AND active_until IS NULL`,
    );
    expect(refs.rows[0]?.ref_record_id).toBe(luis1);
    await db.close();
  });
});
