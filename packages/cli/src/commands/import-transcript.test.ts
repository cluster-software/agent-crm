import { describe, expect, it } from "vitest";
import type { Lix } from "@lix-js/sdk";
import { openTestWorkspace } from "../test/open-test-lix.js";
import { exec } from "@agent-crm/sdk";
import {
  addMultiValue,
  insertRecord,
  setSingleValue,
} from "@agent-crm/sdk";
import { generateUuid } from "@agent-crm/sdk";
import {
  importTranscript,
  parsePayload,
  type ParticipantInput,
  type TranscriptPayload,
} from "./import-transcript.js";

type SeedPerson = {
  email?: string;
  emails?: string[];
  linkedin_url?: string;
  twitter_url?: string;
  name?: string;
};

async function seedPerson(lix: Lix, p: SeedPerson): Promise<string> {
  const id = await generateUuid(lix);
  await insertRecord(lix, "people", id);
  const source = "test";
  const provenance = { test: true };
  const emails = [...(p.emails ?? []), ...(p.email ? [p.email] : [])];
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
  if (p.linkedin_url) {
    await setSingleValue(lix, {
      object_slug: "people",
      record_id: id,
      attribute_slug: "linkedin_url",
      attribute_type: "url",
      value: p.linkedin_url,
      source,
      provenance,
    });
  }
  if (p.twitter_url) {
    await setSingleValue(lix, {
      object_slug: "people",
      record_id: id,
      attribute_slug: "twitter_url",
      attribute_type: "url",
      value: p.twitter_url,
      source,
      provenance,
    });
  }
  if (p.name) {
    await setSingleValue(lix, {
      object_slug: "people",
      record_id: id,
      attribute_slug: "name",
      attribute_type: "personal-name",
      value: p.name,
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
    `SELECT normalized_key FROM acrm_value
     WHERE object_slug = 'people' AND record_id = $1
       AND attribute_slug = $2 AND active_until IS NULL
     LIMIT 1`,
    [personId, attribute_slug],
  );
  return (r.rows[0]?.normalized_key as string | undefined) ?? null;
}

function makePayload(
  participants: ParticipantInput[],
  overrides: Partial<TranscriptPayload> = {},
): TranscriptPayload {
  return {
    source: "granola",
    source_id: "meeting-1",
    title: "Test meeting",
    started_at: "2026-05-13T15:00:00Z",
    ended_at: "2026-05-13T15:30:00Z",
    duration_seconds: 1800,
    summary: "summary",
    content: "transcript body",
    participants,
    ...overrides,
  };
}

describe("parsePayload", () => {
  it("accepts a participant with only `linkedin_url`", () => {
    const out = parsePayload(
      JSON.stringify({
        source: "granola",
        source_id: "x",
        participants: [{ linkedin_url: "linkedin.com/in/foo" }],
      }),
    );
    expect(out.participants).toEqual([
      { linkedin_url: "linkedin.com/in/foo" },
    ]);
  });

  it("accepts a participant with only `twitter_url`", () => {
    const out = parsePayload(
      JSON.stringify({
        source: "granola",
        source_id: "x",
        participants: [{ twitter_url: "@foo" }],
      }),
    );
    expect(out.participants).toEqual([{ twitter_url: "@foo" }]);
  });

  it("accepts every identifier on one participant", () => {
    const out = parsePayload(
      JSON.stringify({
        source: "granola",
        source_id: "x",
        participants: [
          {
            email: "a@b.com",
            linkedin_url: "linkedin.com/in/foo",
            twitter_url: "x.com/foo",
          },
        ],
      }),
    );
    expect(out.participants[0]).toEqual({
      email: "a@b.com",
      linkedin_url: "linkedin.com/in/foo",
      twitter_url: "x.com/foo",
    });
  });

  it("rejects a participant with no identifiers", () => {
    expect(() =>
      parsePayload(
        JSON.stringify({
          source: "granola",
          source_id: "x",
          participants: [{}],
        }),
      ),
    ).toThrow(/at least one of/);
  });

  it("rejects a participant whose only identifier normalizes to empty", () => {
    expect(() =>
      parsePayload(
        JSON.stringify({
          source: "granola",
          source_id: "x",
          participants: [{ linkedin_url: "https://" }],
        }),
      ),
    ).toThrow(/at least one of/);
  });

  it("rejects malformed email", () => {
    expect(() =>
      parsePayload(
        JSON.stringify({
          source: "granola",
          source_id: "x",
          participants: [{ email: "no-at" }],
        }),
      ),
    ).toThrow(/invalid participant email/);
  });
});

describe("importTranscript participant resolution", () => {
  it("resolves a participant matched by email_addresses", async () => {
    const lix = await openTestWorkspace();
    const personId = await seedPerson(lix, {
      email: "alice@acme.com",
      name: "Alice",
    });

    const result = await importTranscript(
      lix,
      makePayload([{ email: "alice@acme.com" }]),
    );

    expect(result.participants.resolved).toHaveLength(1);
    expect(result.participants.unresolved).toHaveLength(0);
    expect(result.participants.resolved[0]?.person_record_id).toBe(personId);
    expect(result.participants.resolved[0]?.matched_by).toBe(
      "email_addresses",
    );
    await lix.close();
  });

  it("resolves a participant matched by linkedin_url when email is missing on record (the original bug)", async () => {
    const lix = await openTestWorkspace();
    const personId = await seedPerson(lix, {
      linkedin_url: "linkedin.com/in/luis-costa-laveron-834b05177",
      name: "Luis",
    });

    const result = await importTranscript(
      lix,
      makePayload([
        {
          email: "luis@hello-cluster.com",
          linkedin_url: "linkedin.com/in/luis-costa-laveron-834b05177",
        },
      ]),
    );

    expect(result.participants.resolved).toHaveLength(1);
    expect(result.participants.unresolved).toHaveLength(0);
    expect(result.participants.resolved[0]?.person_record_id).toBe(personId);
    expect(result.participants.resolved[0]?.matched_by).toBe("linkedin_url");
    await lix.close();
  });

  it("resolves a participant matched by twitter_url", async () => {
    const lix = await openTestWorkspace();
    const personId = await seedPerson(lix, {
      twitter_url: "x.com/carol",
      name: "Carol",
    });

    const result = await importTranscript(
      lix,
      makePayload([{ twitter_url: "@carol" }]),
    );

    expect(result.participants.resolved[0]?.person_record_id).toBe(personId);
    expect(result.participants.resolved[0]?.matched_by).toBe("twitter_url");
    await lix.close();
  });

  it("backfills a missing email onto a person matched by linkedin_url", async () => {
    const lix = await openTestWorkspace();
    const personId = await seedPerson(lix, {
      linkedin_url: "linkedin.com/in/luis",
    });
    expect(await emailsFor(lix, personId)).toEqual([]);

    const result = await importTranscript(
      lix,
      makePayload([
        {
          email: "luis@cluster.com",
          linkedin_url: "linkedin.com/in/luis",
        },
      ]),
    );

    expect(result.participants.resolved[0]?.backfilled).toContain(
      "email_addresses",
    );
    expect(await emailsFor(lix, personId)).toEqual(["luis@cluster.com"]);
    await lix.close();
  });

  it("does not duplicate an email that the person already has", async () => {
    const lix = await openTestWorkspace();
    const personId = await seedPerson(lix, {
      email: "alice@acme.com",
      linkedin_url: "linkedin.com/in/alice",
    });

    const result = await importTranscript(
      lix,
      makePayload([
        {
          email: "alice@acme.com",
          linkedin_url: "linkedin.com/in/alice",
        },
      ]),
    );

    expect(result.participants.resolved[0]?.backfilled).toEqual([]);
    expect(await emailsFor(lix, personId)).toEqual(["alice@acme.com"]);
    await lix.close();
  });

  it("backfills linkedin_url when matched by email and the person has no linkedin on file", async () => {
    const lix = await openTestWorkspace();
    const personId = await seedPerson(lix, { email: "bob@acme.com" });
    expect(await singleValueFor(lix, personId, "linkedin_url")).toBeNull();

    const result = await importTranscript(
      lix,
      makePayload([
        {
          email: "bob@acme.com",
          linkedin_url: "linkedin.com/in/bob",
        },
      ]),
    );

    expect(result.participants.resolved[0]?.backfilled).toContain(
      "linkedin_url",
    );
    expect(await singleValueFor(lix, personId, "linkedin_url")).toBe(
      "linkedin.com/in/bob",
    );
    await lix.close();
  });

  it("does not clobber an existing linkedin_url that disagrees with the payload", async () => {
    const lix = await openTestWorkspace();
    const personId = await seedPerson(lix, {
      email: "bob@acme.com",
      linkedin_url: "linkedin.com/in/bob-curated",
    });

    const result = await importTranscript(
      lix,
      makePayload([
        {
          email: "bob@acme.com",
          linkedin_url: "linkedin.com/in/bob-from-meeting",
        },
      ]),
    );

    expect(result.participants.resolved[0]?.backfilled).not.toContain(
      "linkedin_url",
    );
    expect(await singleValueFor(lix, personId, "linkedin_url")).toBe(
      "linkedin.com/in/bob-curated",
    );
    await lix.close();
  });

  it("auto-creates a person when no record matches the supplied identifiers (covered in autocreate.test.ts)", async () => {
    // The detailed assertions live in import-transcript.autocreate.test.ts.
    // Here we just confirm the old "unresolved" branch is no longer reached
    // for inputs that carry at least one identifier — a regression test on
    // the behavior change itself.
    const lix = await openTestWorkspace();
    const result = await importTranscript(
      lix,
      makePayload([
        {
          email: "ghost@nowhere.com",
          linkedin_url: "linkedin.com/in/ghost",
        },
      ]),
    );
    expect(result.participants.unresolved).toHaveLength(0);
    expect(result.participants.resolved).toHaveLength(1);
    expect(result.participants.resolved[0]?.created).toBe(true);
    await lix.close();
  });

  it("upserts the transcript record and is idempotent across re-imports", async () => {
    const lix = await openTestWorkspace();
    const personId = await seedPerson(lix, { email: "alice@acme.com" });

    const first = await importTranscript(
      lix,
      makePayload([{ email: "alice@acme.com" }]),
    );
    expect(first.created).toBe(true);

    const second = await importTranscript(
      lix,
      makePayload([{ email: "alice@acme.com" }]),
    );
    expect(second.created).toBe(false);
    expect(second.transcript_record_id).toBe(first.transcript_record_id);

    // Participant link is not duplicated.
    const links = await exec(
      lix,
      `SELECT COUNT(*) AS n FROM acrm_value
       WHERE object_slug = 'transcripts' AND record_id = $1
         AND attribute_slug = 'participants'
         AND ref_object = 'people' AND ref_record_id = $2
         AND active_until IS NULL`,
      [first.transcript_record_id, personId],
    );
    expect(Number(links.rows[0]?.n)).toBe(1);

    // Reverse link is not duplicated either.
    const inv = await exec(
      lix,
      `SELECT COUNT(*) AS n FROM acrm_value
       WHERE object_slug = 'people' AND record_id = $1
         AND attribute_slug = 'associated_transcripts'
         AND ref_object = 'transcripts' AND ref_record_id = $2
         AND active_until IS NULL`,
      [personId, first.transcript_record_id],
    );
    expect(Number(inv.rows[0]?.n)).toBe(1);
    await lix.close();
  });

  it("email priority wins even when the payload also carries a stale linkedin", async () => {
    const lix = await openTestWorkspace();
    const aliceById = await seedPerson(lix, {
      email: "alice@acme.com",
      name: "Alice",
    });
    // Different person who happens to have the same LinkedIn URL we'll pass.
    await seedPerson(lix, {
      linkedin_url: "linkedin.com/in/wrong",
      name: "Someone else",
    });

    const result = await importTranscript(
      lix,
      makePayload([
        {
          email: "alice@acme.com",
          linkedin_url: "linkedin.com/in/wrong",
        },
      ]),
    );

    expect(result.participants.resolved[0]?.person_record_id).toBe(aliceById);
    expect(result.participants.resolved[0]?.matched_by).toBe(
      "email_addresses",
    );
    await lix.close();
  });
});
