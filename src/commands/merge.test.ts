import { describe, expect, it } from "vitest";
import type { Lix } from "@lix-js/sdk";
import { openTestWorkspace } from "../test/open-test-lix.js";
import { exec } from "../db/execute.js";
import {
  addMultiValue,
  insertRecord,
  setSingleValue,
} from "../db/upsert.js";
import { generateUuid } from "../lib/ids.js";
import { mergeRecords } from "./merge.js";
import { importTranscript } from "./import-transcript.js";

async function seedPerson(
  lix: Lix,
  spec: {
    email?: string;
    emails?: string[];
    linkedin_url?: string;
    twitter_url?: string;
    name?: string;
    job_title?: string;
  },
): Promise<string> {
  const id = await generateUuid(lix);
  await insertRecord(lix, "people", id);
  const source = "test";
  const provenance = { test: true };
  const emails = [...(spec.emails ?? []), ...(spec.email ? [spec.email] : [])];
  for (const e of emails) {
    await addMultiValue(lix, {
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
    await setSingleValue(lix, {
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
    await setSingleValue(lix, {
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
    await setSingleValue(lix, {
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
    await setSingleValue(lix, {
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

async function emailsFor(lix: Lix, personId: string): Promise<string[]> {
  const r = await exec(
    lix,
    `SELECT normalized_key FROM acrm_value
     WHERE object_slug = 'people' AND record_id = $1
       AND attribute_slug = 'email_addresses' AND active_until IS NULL
     ORDER BY normalized_key`,
    [personId],
  );
  return r.rows.map((row) => row.normalized_key as string);
}

async function singleValueFor(
  lix: Lix,
  personId: string,
  attribute_slug: string,
): Promise<string | null> {
  const r = await exec(
    lix,
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
  lix: Lix,
  object_slug: string,
  record_id: string,
): Promise<boolean> {
  const r = await exec(
    lix,
    `SELECT 1 FROM acrm_record WHERE object_slug = $1 AND record_id = $2`,
    [object_slug, record_id],
  );
  return r.rows.length > 0;
}

describe("mergeRecords", () => {
  it("reassigns multivalued values and dedupes by normalized_key", async () => {
    const lix = await openTestWorkspace();
    const keep = await seedPerson(lix, {
      emails: ["alice@acme.com"],
      name: "Alice",
    });
    const discard = await seedPerson(lix, {
      emails: ["alice@acme.com", "alice.b@acme.com"],
    });

    const result = await mergeRecords(lix, {
      object_slug: "people",
      keep_record_id: keep,
      discard_record_id: discard,
      prefer: "keep",
      dryRun: false,
    });

    expect(result.applied).toBe(true);
    expect(result.discard_record_deleted).toBe(true);
    expect(await recordExists(lix, "people", discard)).toBe(false);

    // Keeper has both emails, deduped.
    expect(await emailsFor(lix, keep)).toEqual([
      "alice.b@acme.com",
      "alice@acme.com",
    ]);
    await lix.close();
  });

  it("moves single-valued attributes when keeper is empty", async () => {
    const lix = await openTestWorkspace();
    const keep = await seedPerson(lix, { email: "luis@cluster.com" });
    const discard = await seedPerson(lix, {
      linkedin_url: "linkedin.com/in/luis",
      job_title: "Founder",
    });

    await mergeRecords(lix, {
      object_slug: "people",
      keep_record_id: keep,
      discard_record_id: discard,
      prefer: "keep",
      dryRun: false,
    });

    expect(await singleValueFor(lix, keep, "linkedin_url")).toBe(
      "linkedin.com/in/luis",
    );
    const titleRow = await exec(
      lix,
      `SELECT value_json FROM acrm_value
       WHERE object_slug='people' AND record_id=$1
         AND attribute_slug='job_title' AND active_until IS NULL`,
      [keep],
    );
    expect(titleRow.rows[0]?.value_json).toContain("Founder");
    await lix.close();
  });

  it("--prefer keep drops discard's single-value on conflict", async () => {
    const lix = await openTestWorkspace();
    const keep = await seedPerson(lix, {
      linkedin_url: "linkedin.com/in/keep",
    });
    const discard = await seedPerson(lix, {
      linkedin_url: "linkedin.com/in/discard",
    });

    const result = await mergeRecords(lix, {
      object_slug: "people",
      keep_record_id: keep,
      discard_record_id: discard,
      prefer: "keep",
      dryRun: false,
    });

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.attribute_slug).toBe("linkedin_url");
    expect(result.conflicts[0]?.resolution).toBe("keep");
    expect(await singleValueFor(lix, keep, "linkedin_url")).toBe(
      "linkedin.com/in/keep",
    );
    await lix.close();
  });

  it("--prefer discard replaces keeper's single-value", async () => {
    const lix = await openTestWorkspace();
    const keep = await seedPerson(lix, {
      linkedin_url: "linkedin.com/in/keep",
    });
    const discard = await seedPerson(lix, {
      linkedin_url: "linkedin.com/in/discard",
    });

    await mergeRecords(lix, {
      object_slug: "people",
      keep_record_id: keep,
      discard_record_id: discard,
      prefer: "discard",
      dryRun: false,
    });

    expect(await singleValueFor(lix, keep, "linkedin_url")).toBe(
      "linkedin.com/in/discard",
    );
    await lix.close();
  });

  it("redirects inbound record-references (transcripts.participants) to the keeper", async () => {
    const lix = await openTestWorkspace();
    const keep = await seedPerson(lix, {
      linkedin_url: "linkedin.com/in/luis",
    });
    const discard = await seedPerson(lix, { email: "luis@cluster.com" });

    // Import a transcript that points at the discard via email.
    await importTranscript(lix, {
      source: "granola",
      source_id: "meeting-1",
      title: "T",
      participants: [{ email: "luis@cluster.com" }],
    });

    // Sanity: the transcript references the discard, not the keeper.
    const before = await exec(
      lix,
      `SELECT ref_record_id FROM acrm_value
       WHERE object_slug='transcripts' AND attribute_slug='participants'
         AND active_until IS NULL`,
    );
    expect(before.rows[0]?.ref_record_id).toBe(discard);

    await mergeRecords(lix, {
      object_slug: "people",
      keep_record_id: keep,
      discard_record_id: discard,
      prefer: "keep",
      dryRun: false,
    });

    // Forward link now points at the keeper.
    const after = await exec(
      lix,
      `SELECT ref_record_id, value_json FROM acrm_value
       WHERE object_slug='transcripts' AND attribute_slug='participants'
         AND active_until IS NULL`,
    );
    expect(after.rows[0]?.ref_record_id).toBe(keep);
    expect(after.rows[0]?.value_json).toContain(keep);

    // Inverse link (people.associated_transcripts) was on the discard;
    // gets moved to the keeper as one of its own multivalued rows.
    const inv = await exec(
      lix,
      `SELECT record_id FROM acrm_value
       WHERE object_slug='people' AND attribute_slug='associated_transcripts'
         AND active_until IS NULL`,
    );
    expect(inv.rows[0]?.record_id).toBe(keep);

    // The discard record is gone.
    expect(await recordExists(lix, "people", discard)).toBe(false);
    await lix.close();
  });

  it("--dry-run reports the plan without mutating", async () => {
    const lix = await openTestWorkspace();
    const keep = await seedPerson(lix, {
      linkedin_url: "linkedin.com/in/luis",
    });
    const discard = await seedPerson(lix, { email: "luis@cluster.com" });

    const plan = await mergeRecords(lix, {
      object_slug: "people",
      keep_record_id: keep,
      discard_record_id: discard,
      prefer: "keep",
      dryRun: true,
    });

    expect(plan.applied).toBe(false);
    expect(plan.discard_record_deleted).toBe(false);
    expect(plan.items.length).toBeGreaterThan(0);
    expect(await recordExists(lix, "people", discard)).toBe(true);
    expect(await emailsFor(lix, keep)).toEqual([]);
    await lix.close();
  });

  it("rejects merging a record with itself", async () => {
    const lix = await openTestWorkspace();
    const id = await seedPerson(lix, { email: "a@b.com" });
    await expect(
      mergeRecords(lix, {
        object_slug: "people",
        keep_record_id: id,
        discard_record_id: id,
        prefer: "keep",
        dryRun: false,
      }),
    ).rejects.toThrow(/same record_id/);
    await lix.close();
  });

  it("rejects unknown keep / discard record_ids", async () => {
    const lix = await openTestWorkspace();
    const id = await seedPerson(lix, { email: "a@b.com" });
    await expect(
      mergeRecords(lix, {
        object_slug: "people",
        keep_record_id: id,
        discard_record_id: "does-not-exist",
        prefer: "keep",
        dryRun: false,
      }),
    ).rejects.toThrow(/discard record_id not found/);
    await lix.close();
  });

  it("end-to-end: reproduces the Luis duplicate scenario from the RCA", async () => {
    const lix = await openTestWorkspace();
    // Luis #1: created by `acrm import linkedin` — has LinkedIn, no email.
    const luis1 = await seedPerson(lix, {
      linkedin_url: "linkedin.com/in/luis-costa-laveron-834b05177",
      name: "Luis Costa Laveron",
      job_title: "Founder",
    });
    // Luis #2: created by `acrm import transcript` from an email-only
    // participant before the resolver could bridge identifier sets.
    const luis2 = await seedPerson(lix, { email: "luis@hello-cluster.com" });

    // Transcript was imported pointing at luis2.
    await importTranscript(lix, {
      source: "granola",
      source_id: "meeting-luis",
      title: "Discovery — Luis",
      participants: [{ email: "luis@hello-cluster.com" }],
    });

    const result = await mergeRecords(lix, {
      object_slug: "people",
      keep_record_id: luis1,
      discard_record_id: luis2,
      prefer: "keep",
      dryRun: false,
    });

    expect(result.applied).toBe(true);
    expect(await recordExists(lix, "people", luis2)).toBe(false);
    expect(await emailsFor(lix, luis1)).toEqual(["luis@hello-cluster.com"]);
    expect(await singleValueFor(lix, luis1, "linkedin_url")).toBe(
      "linkedin.com/in/luis-costa-laveron-834b05177",
    );

    // Transcript now references the kept Luis.
    const refs = await exec(
      lix,
      `SELECT ref_record_id FROM acrm_value
       WHERE object_slug='transcripts' AND attribute_slug='participants'
         AND active_until IS NULL`,
    );
    expect(refs.rows[0]?.ref_record_id).toBe(luis1);
    await lix.close();
  });
});
