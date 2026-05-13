import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import type { Lix } from "@lix-js/sdk";
import { findWorkspace, openWorkspace } from "../workspace/open.js";
import { fail, ok, setJsonMode } from "../output/json.js";
import { generateUuid } from "../lib/ids.js";
import { AcrmError, ERR } from "../lib/errors.js";
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

export type ParticipantInput = {
  email?: string;
  linkedin_url?: string;
  twitter_url?: string;
};

export type TranscriptPayload = {
  source: string;
  source_id: string;
  title?: string;
  started_at?: string;
  ended_at?: string;
  duration_seconds?: number;
  summary?: string;
  content?: string;
  participants: ParticipantInput[];
};

export type ResolvedParticipant = {
  person_record_id: string;
  matched_by: IdentifierAttribute;
  matched_key: string;
  identifiers: ParticipantIdentifiersOut;
  backfilled: IdentifierAttribute[];
};

export type UnresolvedParticipant = {
  identifiers: ParticipantIdentifiersOut;
  reason: "person_not_found" | "no_identifier_provided";
  tried: IdentifierAttribute[];
};

type ParticipantIdentifiersOut = {
  email?: string;
  linkedin_url?: string;
  twitter_url?: string;
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

type Opts = {
  file?: string;
};

export function attachTranscriptSubcommand(parent: Command): void {
  parent
    .command("transcript")
    .description(
      "Import a meeting transcript from canonical JSON (stdin or --file). Use after a call to log Granola/Zoom/Meet transcripts into the workspace. Upserts a `transcripts` record (deduped by `source_id`), resolves each participant by any of email / LinkedIn URL / Twitter URL (in that priority), and links them via `transcripts.participants` + `people.associated_transcripts`. Participants whose identifiers don't match an existing person are reported in `unresolved`.",
    )
    .option("--file <path>", "read JSON from file instead of stdin")
    .addHelpText(
      "after",
      `
Input shape (JSON):
  {
    "source": "granola" | "zoom" | "meet" | "teams" | "manual" | "other",
    "source_id": "<unique-string>",         (required)
    "title": "Discovery — Acme",
    "started_at": "2026-05-11T15:00:00Z",
    "ended_at":   "2026-05-11T15:30:00Z",
    "duration_seconds": 1800,
    "summary": "...",
    "content":  "<raw transcript>",
    "participants": [
      { "email": "alice@acme.com" },
      { "linkedin_url": "linkedin.com/in/bob-jones" },
      { "email": "carol@acme.com", "linkedin_url": "linkedin.com/in/carol" }
    ]                                       (required, non-empty)
  }

Each participant must carry at least one of email / linkedin_url / twitter_url.
Resolution priority: email_addresses → linkedin_url → twitter_url. If a person
is matched by LinkedIn/Twitter and the payload also carried an email (or other
identifier) the record doesn't have yet, the missing identifier is backfilled.

Examples:
  cat transcript.json | acrm import transcript
  acrm import transcript --file ./transcript.json

Re-running with the same source_id is safe — the transcript record is matched by
source_id, scalar fields are updated in place, and participant links dedupe.
`,
    )
    .action(async (opts: Opts) => {
      const root = parent.parent?.opts() as
        | { workspace?: string; json?: boolean }
        | undefined;
      setJsonMode(root?.json);
      try {
        const result = await runImportTranscript({
          workspace: root?.workspace,
          file: opts.file,
        });
        ok(result);
      } catch (e) {
        if (e instanceof AcrmError) fail(e.message, e.code, e.hint);
        else fail(e instanceof Error ? e.message : String(e), ERR.UNHANDLED);
        process.exit(1);
      }
    });
}

async function runImportTranscript(opts: {
  workspace?: string;
  file?: string;
}): Promise<TranscriptImportResult> {
  const raw = opts.file
    ? await readFile(path.resolve(opts.file), "utf8")
    : await readStdin();
  if (!raw.trim()) {
    throw new AcrmError(
      "no input received (pipe JSON to stdin or pass --file)",
      ERR.INVALID_INPUT,
    );
  }
  const payload = parsePayload(raw);

  const workspaceFile = opts.workspace
    ? path.resolve(
        opts.workspace.endsWith(".acrm")
          ? opts.workspace
          : opts.workspace + ".acrm",
      )
    : findWorkspace();
  if (!workspaceFile) {
    throw new AcrmError(
      "no .acrm file found (run `acrm init <name>.acrm` to create one)",
      ERR.NO_WORKSPACE,
    );
  }

  const lix = await openWorkspace({ workspace: workspaceFile });
  try {
    return await importTranscript(lix, payload);
  } finally {
    await lix.close();
  }
}

// Exposed for tests and for programmatic callers that already hold a Lix.
export async function importTranscript(
  lix: Lix,
  payload: TranscriptPayload,
): Promise<TranscriptImportResult> {
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
      });
    } else {
      unresolved.push({
        identifiers: identifiersOut,
        reason:
          result.tried.length === 0
            ? "no_identifier_provided"
            : "person_not_found",
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

function normalizedToOut(
  n: NormalizedIdentifiers,
): ParticipantIdentifiersOut {
  const out: ParticipantIdentifiersOut = {};
  if (n.emails[0]) out.email = n.emails[0];
  if (n.linkedin_url) out.linkedin_url = n.linkedin_url;
  if (n.twitter_url) out.twitter_url = n.twitter_url;
  return out;
}

// When a transcript carries identifiers that the matched person doesn't yet
// have on file, fill them in. This closes the loop on the original bug: a
// person matched by LinkedIn whose email the meeting provider supplied gets
// that email added to their record. Single-value attributes (linkedin_url,
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
    backfilled_at: new Date().toISOString(),
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

function parsePayload(raw: string): TranscriptPayload {
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

async function upsertTranscript(
  lix: Lix,
  payload: TranscriptPayload,
): Promise<{ transcriptId: string; created: boolean }> {
  const source = `transcript-import:${payload.source}`;
  const provenance = {
    source: payload.source,
    source_id: payload.source_id,
    imported_at: new Date().toISOString(),
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
  const provenance = { linked_at: new Date().toISOString() };

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

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Re-exported for tests that want to exercise parsing alone.
export { parsePayload };
