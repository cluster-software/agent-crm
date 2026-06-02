import { describe, expect, it } from "vitest";
import type { AcrmDatabase } from "@agent-crm/sdk";
import { openTestWorkspace } from "../test/open-test-db.js";
import { exec } from "../../../sdk/src/db/execute.js";
import { importTranscript, Workspace } from "@agent-crm/sdk";

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
    `SELECT normalized_key FROM acrm_value
     WHERE object_slug = 'people' AND record_id = $1
       AND attribute_slug = $2 AND active_until IS NULL
     LIMIT 1`,
    [personId, attribute_slug],
  );
  return (r.rows[0]?.normalized_key as string | undefined) ?? null;
}

const basePayload = {
  source: "granola",
  source_id: "meeting-autocreate",
  title: "Test",
  started_at: "2026-05-13T15:00:00Z",
  ended_at: "2026-05-13T15:30:00Z",
};

describe("auto-create unresolved participants", () => {
  it("creates a person from email when no record matches", async () => {
    const db = await openTestWorkspace();
    const result = await importTranscript(Workspace.fromDatabase(db), {
      ...basePayload,
      participants: [{ email: "newperson@acme.com" }],
    });

    expect(result.participants.resolved).toHaveLength(1);
    expect(result.participants.unresolved).toHaveLength(0);
    const r = result.participants.resolved[0]!;
    expect(r.created).toBe(true);
    expect(r.matched_by).toBe("created");
    expect(r.matched_key).toBe("newperson@acme.com");
    expect(await emailsFor(db, r.person_record_id)).toEqual([
      "newperson@acme.com",
    ]);
    await db.close();
  });

  it("creates a person from linkedin_url alone", async () => {
    const db = await openTestWorkspace();
    const result = await importTranscript(Workspace.fromDatabase(db), {
      ...basePayload,
      participants: [{ linkedin_url: "linkedin.com/in/newperson" }],
    });

    const r = result.participants.resolved[0]!;
    expect(r.created).toBe(true);
    expect(await singleValueFor(db, r.person_record_id, "linkedin_url")).toBe(
      "linkedin.com/in/newperson",
    );
    await db.close();
  });

  it("creates with every identifier the payload supplies", async () => {
    const db = await openTestWorkspace();
    const result = await importTranscript(Workspace.fromDatabase(db), {
      ...basePayload,
      participants: [
        {
          email: "carol@acme.com",
          linkedin_url: "linkedin.com/in/carol",
          twitter_url: "x.com/carol",
        },
      ],
    });
    const r = result.participants.resolved[0]!;
    expect(r.created).toBe(true);
    expect(await emailsFor(db, r.person_record_id)).toEqual([
      "carol@acme.com",
    ]);
    expect(await singleValueFor(db, r.person_record_id, "linkedin_url")).toBe(
      "linkedin.com/in/carol",
    );
    expect(await singleValueFor(db, r.person_record_id, "twitter_url")).toBe(
      "x.com/carol",
    );
    await db.close();
  });

  it("links the created person to the transcript via both directions", async () => {
    const db = await openTestWorkspace();
    const result = await importTranscript(Workspace.fromDatabase(db), {
      ...basePayload,
      source_id: "linked-meeting",
      participants: [{ email: "linked@acme.com" }],
    });

    const personId = result.participants.resolved[0]!.person_record_id;
    const transcriptId = result.transcript_record_id;

    const fwd = await exec(
      db,
      `SELECT 1 FROM acrm_value
       WHERE object_slug='transcripts' AND record_id=$1
         AND attribute_slug='participants'
         AND ref_object='people' AND ref_record_id=$2
         AND active_until IS NULL LIMIT 1`,
      [transcriptId, personId],
    );
    expect(fwd.rows).toHaveLength(1);

    const inv = await exec(
      db,
      `SELECT 1 FROM acrm_value
       WHERE object_slug='people' AND record_id=$1
         AND attribute_slug='associated_transcripts'
         AND ref_object='transcripts' AND ref_record_id=$2
         AND active_until IS NULL LIMIT 1`,
      [personId, transcriptId],
    );
    expect(inv.rows).toHaveLength(1);
    await db.close();
  });

  it("does not create a duplicate when the same identifier is imported twice", async () => {
    const db = await openTestWorkspace();
    const first = await importTranscript(Workspace.fromDatabase(db), {
      ...basePayload,
      source_id: "dup-test",
      participants: [{ email: "dup@acme.com" }],
    });
    expect(first.participants.resolved[0]?.created).toBe(true);
    const firstPersonId = first.participants.resolved[0]!.person_record_id;

    // Re-import the same meeting with the same participant: should now
    // *match* the person we just created, not create a second copy.
    const second = await importTranscript(Workspace.fromDatabase(db), {
      ...basePayload,
      source_id: "dup-test",
      participants: [{ email: "dup@acme.com" }],
    });
    expect(second.participants.resolved[0]?.created).toBe(false);
    expect(second.participants.resolved[0]?.matched_by).toBe(
      "email_addresses",
    );
    expect(second.participants.resolved[0]?.person_record_id).toBe(
      firstPersonId,
    );

    // And exactly one person record exists with that email.
    const r = await exec(
      db,
      `SELECT COUNT(DISTINCT record_id) AS n FROM acrm_value
       WHERE object_slug='people' AND attribute_slug='email_addresses'
         AND normalized_key='dup@acme.com' AND active_until IS NULL`,
    );
    expect(Number(r.rows[0]?.n)).toBe(1);
    await db.close();
  });
});
