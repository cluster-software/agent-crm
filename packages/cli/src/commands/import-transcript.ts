import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import {
  AcrmError,
  ERR,
  Workspace,
  importTranscript,
  parseTranscriptPayload,
  type TranscriptImportResult,
  type TranscriptPayload,
} from "@agent-crm/sdk";
import { resolveWorkspacePath } from "../workspace-resolve.js";
import { fail, ok, setJsonMode } from "../output/json.js";

type Opts = {
  file?: string;
  from?: string;
};

const NATIVE_TRANSCRIPT_PROVIDERS: string[] = [];

export function attachTranscriptSubcommand(parent: Command): void {
  parent
    .command("transcript [meeting-id]")
    .description(
      "Import a meeting transcript from canonical JSON. Upserts a `transcripts` record (deduped by `source_id`), resolves each participant by email / LinkedIn URL / Twitter URL, and auto-creates `people` records for unknown participants that carry an identifier.",
    )
    .option(
      "--from <provider>",
      `fetch directly from a native provider adapter (supported: ${NATIVE_TRANSCRIPT_PROVIDERS.join(", ") || "none"}).`,
    )
    .option(
      "--file <path>",
      "read canonical JSON from file (manual path; use when no native --from adapter exists for the source)",
    )
    .addHelpText(
      "after",
      `
Two forms:

  acrm import transcript --from <provider> <meeting-id>
      Native transcript adapters are not currently bundled here.
      Supported providers: ${NATIVE_TRANSCRIPT_PROVIDERS.join(", ") || "none"}.
      For Granola, use:
          acrm connect granola
          acrm import granola

  acrm import transcript --file <path>     (or pipe JSON to stdin)
      Manual path. Use for sources without a native CLI adapter (Otter,
      Fathom, Fireflies, manual paste, etc.). You supply canonical JSON;
      the CLI handles upsert, participant resolution, and dedup.

      Examples:
          cat transcript.json | acrm import transcript
          acrm import transcript --file ./transcript.json

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

      Each participant must carry at least one of email / linkedin_url /
      twitter_url. Resolution priority: email_addresses → linkedin_url →
      twitter_url. If a person is matched by LinkedIn/Twitter and the payload
      also carried an email (or other identifier) the record doesn't have yet,
      the missing identifier is backfilled.

Re-running with the same source_id is safe — the transcript record is matched
by source_id, scalar fields are updated in place, and participant links dedupe.
Unknown participants that carry at least one identifier are auto-created in
\`people\` and linked.
`,
    )
    .action(async (meetingId: string | undefined, opts: Opts) => {
      const root = parent.parent?.opts() as
        | { workspace?: string; json?: boolean }
        | undefined;
      setJsonMode(root?.json);
      try {
        const result = await runImportTranscript({
          workspace: root?.workspace,
          file: opts.file,
          from: opts.from,
          meetingId,
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
  from?: string;
  meetingId?: string;
}): Promise<TranscriptImportResult> {
  const payload = await loadPayload(opts);

  const ws = await Workspace.open(resolveWorkspacePath(opts.workspace));
  try {
    return await importTranscript(ws, payload);
  } finally {
    await ws.close();
  }
}

// Resolves the canonical payload from whichever source the user asked for.
// `--file` and stdin are the manual path. Provider-specific fast paths such as
// Granola have their own import commands.
async function loadPayload(opts: {
  file?: string;
  from?: string;
  meetingId?: string;
}): Promise<TranscriptPayload> {
  if (opts.from) {
    if (opts.file) {
      throw new AcrmError(
        "use either --from <provider> or --file, not both",
        ERR.INVALID_INPUT,
      );
    }
    throw new AcrmError(
      `unknown --from provider: ${opts.from}. Supported: ${NATIVE_TRANSCRIPT_PROVIDERS.join(", ") || "none"}`,
      ERR.INVALID_INPUT,
      opts.from.toLowerCase() === "granola" ? "use: acrm import granola" : undefined,
    );
  }

  if (opts.meetingId) {
    throw new AcrmError(
      "positional meeting id is only valid with --from <provider>",
      ERR.INVALID_INPUT,
    );
  }

  const raw = opts.file
    ? await readFile(path.resolve(opts.file), "utf8")
    : await readStdin();
  if (!raw.trim()) {
    throw new AcrmError(
      "no input received (pipe JSON to stdin, pass --file, or use a provider-specific import command)",
      ERR.INVALID_INPUT,
    );
  }
  return parseTranscriptPayload(raw);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
