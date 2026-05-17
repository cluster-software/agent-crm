import type { Lix } from "@lix-js/sdk";
import { exec } from "../db/execute.js";
import {
  addMultiValue,
  findRecordByUnique,
  insertRecord,
  setSingleValue,
} from "../db/upsert.js";
import {
  normalizeIdentifiers,
  resolvePersonByIdentifiers,
  type IdentifierAttribute,
  type NormalizedIdentifiers,
} from "../domain/resolve-person.js";
import { AcrmError, ERR } from "../lib/errors.js";
import { generateUuid } from "../lib/ids.js";
import { nowIso } from "../lib/time.js";
import type {
  ParticipantInput,
  TranscriptPayload,
} from "../integrations/transcript.js";
import type { Workspace } from "../workspace.js";

type ParticipantIdentifiersOut = {
  email?: string;
  linkedin_url?: string;
  twitter_url?: string;
};

export type ResolvedParticipant = {
  person_record_id: string;
  matched_by: IdentifierAttribute | "created";
  matched_key: string;
  identifiers: ParticipantIdentifiersOut;
  backfilled: IdentifierAttribute[];
  created: boolean;
};

export type UnresolvedParticipant = {
  identifiers: ParticipantIdentifiersOut;
  reason: "person_not_found" | "no_identifier_provided";
  tried: IdentifierAttribute[];
};

export type TranscriptImportResult = {
  transcript_record_id: string;
  created: boolean;
  source: string;
  source_id: string;
  participants: {
    resolved: ResolvedParticipant[];
    unresolved: UnresolvedParticipant[];
  };
};

// Upsert a `transcripts` record (deduped by `source_id`), resolve each
// participant by email / LinkedIn / Twitter (auto-creating `people` rows
// for unknown participants that carry an identifier), and link them.
// Re-running with the same `source_id` is safe: scalar fields are updated
// in place and participant links dedupe.
export async function importTranscript(
  workspace: Workspace,
  payload: TranscriptPayload,
): Promise<TranscriptImportResult> {
  const lix = workspace.lix;
  const resolved: ResolvedParticipant[] = [];
  const unresolved: UnresolvedParticipant[] = [];

  for (const p of payload.participants) {
    const result = await resolvePersonByIdentifiers(
      (attr, key) => findRecordByUnique(lix, "people", attr, key),
      { email: p.email, linkedin_url: p.linkedin_url, twitter_url: p.twitter_url },
    );

    const identifiersOut = normalizedToOut(result.normalized);

    if (result.person_record_id && result.matched_by && result.matched_key) {
      const backfilled = await backfillIdentifiers(
        lix,
        result.person_record_id,
        result.normalized,
        result.matched_by,
        payload.source,
      );
      resolved.push({
        person_record_id: result.person_record_id,
        matched_by: result.matched_by,
        matched_key: result.matched_key,
        identifiers: identifiersOut,
        backfilled,
        created: false,
      });
    } else if (result.tried.length > 0) {
      // Auto-create: participant carried at least one identifier but no
      // person matched. Create the record now and link as resolved — keeps
      // the transcript walkable from the new person record on day one.
      const personId = await createPersonFromIdentifiers(
        lix,
        result.normalized,
        payload.source,
      );
      resolved.push({
        person_record_id: personId,
        matched_by: "created",
        matched_key: firstIdentifierKey(result.normalized),
        identifiers: identifiersOut,
        backfilled: [],
        created: true,
      });
    } else {
      // No identifier survived normalization. parseTranscriptPayload rejects
      // this case, so we should never get here in practice — keep the branch
      // so the type is exhaustive and future callers that bypass parsing
      // still get a structured response.
      unresolved.push({
        identifiers: identifiersOut,
        reason: "no_identifier_provided",
        tried: result.tried,
      });
    }
  }

  const { transcriptId, created } = await upsertTranscript(lix, payload);

  for (const r of resolved) {
    await linkParticipant(lix, transcriptId, r.person_record_id, payload.source);
  }

  return {
    transcript_record_id: transcriptId,
    created,
    source: payload.source,
    source_id: payload.source_id,
    participants: { resolved, unresolved },
  };
}

async function createPersonFromIdentifiers(
  lix: Lix,
  normalized: NormalizedIdentifiers,
  importSource: string,
): Promise<string> {
  const personId = await generateUuid(lix);
  await insertRecord(lix, "people", personId);
  const source = `transcript-import:${importSource}`;
  const provenance = {
    created_at: nowIso(),
    via: "transcript-participant",
  };
  for (const email of normalized.emails) {
    await addMultiValue(lix, {
      object_slug: "people",
      record_id: personId,
      attribute_slug: "email_addresses",
      attribute_type: "email-address",
      value: email,
      source,
      provenance,
    });
  }
  if (normalized.linkedin_url) {
    await setSingleValue(lix, {
      object_slug: "people",
      record_id: personId,
      attribute_slug: "linkedin_url",
      attribute_type: "url",
      value: normalized.linkedin_url,
      source,
      provenance,
    });
  }
  if (normalized.twitter_url) {
    await setSingleValue(lix, {
      object_slug: "people",
      record_id: personId,
      attribute_slug: "twitter_url",
      attribute_type: "url",
      value: normalized.twitter_url,
      source,
      provenance,
    });
  }
  return personId;
}

function firstIdentifierKey(n: NormalizedIdentifiers): string {
  return n.emails[0] ?? n.linkedin_url ?? n.twitter_url ?? "";
}

function normalizedToOut(n: NormalizedIdentifiers): ParticipantIdentifiersOut {
  const out: ParticipantIdentifiersOut = {};
  if (n.emails[0]) out.email = n.emails[0];
  if (n.linkedin_url) out.linkedin_url = n.linkedin_url;
  if (n.twitter_url) out.twitter_url = n.twitter_url;
  return out;
}

// When a transcript carries identifiers that the matched person doesn't yet
// have on file, fill them in. Single-value attributes (linkedin_url,
// twitter_url) are only set when currently empty — we never clobber a value
// the user has curated.
async function backfillIdentifiers(
  lix: Lix,
  personId: string,
  normalized: NormalizedIdentifiers,
  matchedBy: IdentifierAttribute,
  importSource: string,
): Promise<IdentifierAttribute[]> {
  const backfilled: IdentifierAttribute[] = [];
  const source = `transcript-import:${importSource}`;
  const provenance = {
    backfilled_at: nowIso(),
    matched_by: matchedBy,
  };

  for (const email of normalized.emails) {
    const existing = await exec(
      lix,
      `SELECT 1 FROM acrm_value
       WHERE object_slug = 'people' AND record_id = $1
         AND attribute_slug = 'email_addresses'
         AND normalized_key = $2
         AND active_until IS NULL LIMIT 1`,
      [personId, email],
    );
    if (existing.rows.length) continue;
    await addMultiValue(lix, {
      object_slug: "people",
      record_id: personId,
      attribute_slug: "email_addresses",
      attribute_type: "email-address",
      value: email,
      source,
      provenance,
    });
    backfilled.push("email_addresses");
  }

  for (const attr of ["linkedin_url", "twitter_url"] as const) {
    const key = normalized[attr];
    if (!key) continue;
    const existing = await exec(
      lix,
      `SELECT 1 FROM acrm_value
       WHERE object_slug = 'people' AND record_id = $1
         AND attribute_slug = $2
         AND active_until IS NULL LIMIT 1`,
      [personId, attr],
    );
    if (existing.rows.length) continue;
    await setSingleValue(lix, {
      object_slug: "people",
      record_id: personId,
      attribute_slug: attr,
      attribute_type: "url",
      value: key,
      source,
      provenance,
    });
    backfilled.push(attr);
  }

  return backfilled;
}

async function upsertTranscript(
  lix: Lix,
  payload: TranscriptPayload,
): Promise<{ transcriptId: string; created: boolean }> {
  const source = `transcript-import:${payload.source}`;
  const provenance = {
    source: payload.source,
    source_id: payload.source_id,
    imported_at: nowIso(),
  };

  let transcriptId = await findRecordByUnique(
    lix,
    "transcripts",
    "source_id",
    payload.source_id,
  );
  let created = false;
  if (!transcriptId) {
    transcriptId = await generateUuid(lix);
    await insertRecord(lix, "transcripts", transcriptId);
    created = true;
  }

  await setSingleValue(lix, {
    object_slug: "transcripts",
    record_id: transcriptId,
    attribute_slug: "source",
    attribute_type: "status",
    value: payload.source,
    source,
    provenance,
  });

  await setSingleValue(lix, {
    object_slug: "transcripts",
    record_id: transcriptId,
    attribute_slug: "source_id",
    attribute_type: "text",
    value: payload.source_id,
    source,
    provenance,
  });

  const scalars: [string, "text" | "timestamp" | "number", unknown][] = [
    ["title", "text", payload.title],
    ["started_at", "timestamp", payload.started_at],
    ["ended_at", "timestamp", payload.ended_at],
    ["duration_seconds", "number", payload.duration_seconds],
    ["summary", "text", payload.summary],
    ["content", "text", payload.content],
  ];
  for (const [slug, type, value] of scalars) {
    if (value === undefined) continue;
    await setSingleValue(lix, {
      object_slug: "transcripts",
      record_id: transcriptId,
      attribute_slug: slug,
      attribute_type: type,
      value,
      source,
      provenance,
    });
  }

  return { transcriptId, created };
}

async function linkParticipant(
  lix: Lix,
  transcriptId: string,
  personId: string,
  importSource: string,
): Promise<void> {
  const source = `transcript-import:${importSource}`;
  const provenance = { linked_at: nowIso() };

  const fwd = await exec(
    lix,
    `SELECT 1 FROM acrm_value
     WHERE object_slug = 'transcripts' AND record_id = $1
       AND attribute_slug = 'participants'
       AND ref_object = 'people' AND ref_record_id = $2
       AND active_until IS NULL LIMIT 1`,
    [transcriptId, personId],
  );
  if (!fwd.rows.length) {
    await addMultiValue(lix, {
      object_slug: "transcripts",
      record_id: transcriptId,
      attribute_slug: "participants",
      attribute_type: "record-reference",
      value: { target_object: "people", target_record_id: personId },
      source,
      provenance,
    });
  }

  const inv = await exec(
    lix,
    `SELECT 1 FROM acrm_value
     WHERE object_slug = 'people' AND record_id = $1
       AND attribute_slug = 'associated_transcripts'
       AND ref_object = 'transcripts' AND ref_record_id = $2
       AND active_until IS NULL LIMIT 1`,
    [personId, transcriptId],
  );
  if (!inv.rows.length) {
    await addMultiValue(lix, {
      object_slug: "people",
      record_id: personId,
      attribute_slug: "associated_transcripts",
      attribute_type: "record-reference",
      value: { target_object: "transcripts", target_record_id: transcriptId },
      source,
      provenance,
    });
  }
}

// Parse a JSON string into a canonical TranscriptPayload. Throws AcrmError
// on malformed input; never reads from stdin / process / disk. Useful both
// for the CLI's --file / stdin paths and for programmatic callers that
// receive transcript JSON over the wire.
export function parseTranscriptPayload(raw: string): TranscriptPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new AcrmError(
      `input is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      ERR.INVALID_INPUT,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AcrmError("expected a JSON object", ERR.INVALID_INPUT);
  }
  const p = parsed as Record<string, unknown>;
  const source = typeof p.source === "string" ? p.source.trim() : "";
  if (!source) throw new AcrmError("`source` is required", ERR.INVALID_INPUT);
  const source_id =
    typeof p.source_id === "string" ? p.source_id.trim() : "";
  if (!source_id)
    throw new AcrmError("`source_id` is required", ERR.INVALID_INPUT);
  const participantsRaw = Array.isArray(p.participants) ? p.participants : null;
  if (!participantsRaw || participantsRaw.length === 0) {
    throw new AcrmError(
      "`participants` must be a non-empty array",
      ERR.INVALID_INPUT,
    );
  }
  const participants: ParticipantInput[] = [];
  for (const item of participantsRaw) {
    if (!item || typeof item !== "object") {
      throw new AcrmError(
        "each participant must be an object with at least one of `email`, `linkedin_url`, `twitter_url`",
        ERR.INVALID_INPUT,
      );
    }
    const rec = item as Record<string, unknown>;
    const out: ParticipantInput = {};

    if (rec.email !== undefined) {
      if (typeof rec.email !== "string" || !rec.email.includes("@")) {
        throw new AcrmError(
          `invalid participant email: ${JSON.stringify(rec.email)}`,
          ERR.INVALID_INPUT,
        );
      }
      out.email = rec.email;
    }
    if (rec.linkedin_url !== undefined) {
      if (typeof rec.linkedin_url !== "string" || !rec.linkedin_url.trim()) {
        throw new AcrmError(
          `invalid participant linkedin_url: ${JSON.stringify(rec.linkedin_url)}`,
          ERR.INVALID_INPUT,
        );
      }
      out.linkedin_url = rec.linkedin_url;
    }
    if (rec.twitter_url !== undefined) {
      if (typeof rec.twitter_url !== "string" || !rec.twitter_url.trim()) {
        throw new AcrmError(
          `invalid participant twitter_url: ${JSON.stringify(rec.twitter_url)}`,
          ERR.INVALID_INPUT,
        );
      }
      out.twitter_url = rec.twitter_url;
    }

    // After normalization, every identifier must produce at least one usable
    // key — otherwise the participant entry would be pure noise.
    const probe = normalizeIdentifiers(out);
    if (!probe.emails.length && !probe.linkedin_url && !probe.twitter_url) {
      throw new AcrmError(
        "each participant must carry at least one of `email`, `linkedin_url`, `twitter_url`",
        ERR.INVALID_INPUT,
      );
    }
    participants.push(out);
  }
  return {
    source,
    source_id,
    title: optString(p.title),
    started_at: optString(p.started_at),
    ended_at: optString(p.ended_at),
    duration_seconds: optNumber(p.duration_seconds),
    summary: optString(p.summary),
    content: optString(p.content),
    participants,
  };
}

function optString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s.length ? s : undefined;
}

function optNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim().length) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}
