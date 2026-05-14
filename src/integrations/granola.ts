// Granola transcript-fetch adapter. Reads the cached OAuth token, calls the
// Granola MCP server tools (list_meetings, get_meeting_transcript, get_meetings)
// via JSON-RPC over HTTP, and returns canonical TranscriptPayload bytes that
// `acrm import transcript` can feed to `importTranscript()`. Transcript bytes
// never pass through the LLM.

import { AcrmError, ERR } from "../lib/errors.js";
import { readToken } from "../lib/token-cache.js";
import {
  McpHttpClient,
  unwrapToolResult,
} from "./mcp-http-client.js";
import type { TranscriptProvider } from "./provider.js";
import type {
  ParticipantInput,
  TranscriptPayload,
} from "../commands/import-transcript.js";

export const GRANOLA_PROVIDER = "granola";
export const GRANOLA_MCP_ENDPOINT = "https://mcp.granola.ai/mcp";
export const GRANOLA_DISCOVERY_URL =
  "https://mcp.granola.ai/.well-known/oauth-authorization-server";

export const granolaProvider: TranscriptProvider = {
  name: GRANOLA_PROVIDER,
  label: "Granola",
  fetchTranscript: (meetingId) => fetchGranolaTranscript(meetingId),
  oauth: {
    discoveryUrl: GRANOLA_DISCOVERY_URL,
    // Granola's MCP server requires RFC 7591 Dynamic Client Registration —
    // there is no static public `client_id`. Leaving this undefined makes
    // `acrm auth granola` register a fresh client per auth. Set
    // ACRM_GRANOLA_CLIENT_ID to override with a pre-registered client.
    clientId: process.env.ACRM_GRANOLA_CLIENT_ID?.trim() || undefined,
    scope: process.env.ACRM_GRANOLA_SCOPE?.trim() || undefined,
  },
};

export type GranolaFetchOpts = {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  // Inject a client directly for tests. Skips token cache lookup.
  client?: McpHttpClient;
};

export async function fetchGranolaTranscript(
  meetingId: string,
  opts: GranolaFetchOpts = {},
): Promise<TranscriptPayload> {
  const id = meetingId.trim();
  if (!id) {
    throw new AcrmError(
      "meeting id is required for --from granola",
      ERR.INVALID_INPUT,
    );
  }

  const client = opts.client ?? (await buildGranolaClient(opts));

  const transcriptResult = unwrapToolResult(
    await client.callTool("get_meeting_transcript", { meeting_id: id }),
  );
  const meetingsResult = unwrapToolResult(
    await client.callTool("get_meetings", { meeting_ids: [id] }),
  );

  const content = extractTranscriptContent(transcriptResult);
  const meeting = extractMeeting(meetingsResult, id);

  return buildPayload({
    meetingId: id,
    content,
    meeting,
  });
}

async function buildGranolaClient(
  opts: GranolaFetchOpts,
): Promise<McpHttpClient> {
  const token = await readToken(GRANOLA_PROVIDER);
  if (!token) {
    throw new AcrmError(
      "no cached Granola credentials found",
      ERR.IMPORT,
      "run: acrm auth granola",
    );
  }
  return new McpHttpClient({
    endpoint: opts.endpoint ?? GRANOLA_MCP_ENDPOINT,
    bearerToken: token.access_token,
    fetchImpl: opts.fetchImpl,
  });
}

// Tool responses from Granola vary by version. Be permissive: accept the raw
// transcript string, an object with `content`/`transcript`/`text`, or a
// nested `{ transcript: { content: "..." } }` shape.
export function extractTranscriptContent(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (!raw || typeof raw !== "object") {
    throw new AcrmError(
      "Granola returned no transcript content",
      ERR.IMPORT,
    );
  }
  const r = raw as Record<string, unknown>;
  for (const key of ["content", "transcript", "text", "body"]) {
    const v = r[key];
    if (typeof v === "string" && v.length) return v;
  }
  // Nested: { transcript: { content: "..." } }
  const nested = r.transcript;
  if (nested && typeof nested === "object") {
    const nestedContent = (nested as Record<string, unknown>).content;
    if (typeof nestedContent === "string") return nestedContent;
  }
  throw new AcrmError(
    "Granola transcript response did not include a content/transcript/text field",
    ERR.IMPORT,
  );
}

type GranolaMeeting = {
  id: string;
  title?: string;
  start?: string;
  end?: string;
  duration?: number;
  summary?: string;
  participants: ParticipantInput[];
};

export function extractMeeting(
  raw: unknown,
  meetingId: string,
): GranolaMeeting {
  // Granola's get_meetings returns XML inside the MCP text block, not JSON.
  // unwrapToolResult leaves it as a string; we detect the XML envelope here.
  if (typeof raw === "string" && raw.trimStart().startsWith("<")) {
    return parseGranolaMeetingsXml(raw, meetingId);
  }
  const candidates = unwrapMeetingsList(raw);
  const m = candidates.find((c) => meetingMatchesId(c, meetingId));
  if (!m) {
    throw new AcrmError(
      `Granola meeting ${meetingId} not found in get_meetings response`,
      ERR.NOT_FOUND,
    );
  }
  const participants = extractParticipants(m);
  return {
    id: pickString(m, ["id", "meeting_id", "uuid"]) ?? meetingId,
    title: pickString(m, ["title", "name", "subject"]),
    start: pickString(m, [
      "started_at",
      "start_time",
      "start",
      "starts_at",
      "scheduled_start",
    ]),
    end: pickString(m, [
      "ended_at",
      "end_time",
      "end",
      "ends_at",
      "scheduled_end",
    ]),
    duration: pickNumber(m, ["duration_seconds", "duration"]),
    summary: pickString(m, ["summary", "ai_summary", "notes_summary"]),
    participants,
  };
}

// Granola wraps each meeting in `<meeting id=... title=... date=...>` with
// `<known_participants>` and `<summary>` children. We can't use a strict XML
// parser because email tokens are emitted as `<addr@host>` inside the
// participants block, which makes the document invalid XML by spec. A few
// non-greedy regexes are enough since the structure is tightly constrained
// to what the MCP server emits.
export function parseGranolaMeetingsXml(
  xml: string,
  meetingId: string,
): GranolaMeeting {
  const wanted = meetingId.toLowerCase();
  const meetingRe = /<meeting\s+([^>]+)>([\s\S]*?)<\/meeting>/g;
  let m: RegExpExecArray | null;
  while ((m = meetingRe.exec(xml)) !== null) {
    const attrs = parseXmlAttributes(m[1]!);
    const body = m[2]!;
    const id = (attrs.id ?? "").toLowerCase();
    if (id !== wanted) continue;

    const knownParticipantsText = extractXmlBody(body, "known_participants");
    const summary = extractXmlBody(body, "summary");
    const dateRaw = attrs.date;
    const startIso = dateRaw ? toIso8601(dateRaw) : undefined;

    return {
      id: attrs.id ?? meetingId,
      title: attrs.title,
      start: startIso,
      end: undefined,
      duration: undefined,
      summary,
      participants: parseParticipantsText(knownParticipantsText ?? ""),
    };
  }
  throw new AcrmError(
    `Granola meeting ${meetingId} not found in get_meetings XML response`,
    ERR.NOT_FOUND,
  );
}

function parseXmlAttributes(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const attrRe = /(\w+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(s)) !== null) {
    out[m[1]!] = m[2]!;
  }
  return out;
}

function extractXmlBody(body: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
  const m = re.exec(body);
  if (!m) return undefined;
  const text = m[1]!.trim();
  return text.length ? text : undefined;
}

// "Enrique Goudet (note creator) from Cluster <enrique@hello-cluster.com>,
//  Luis Costa Laveron from Hello-cluster <luis@hello-cluster.com>"
// Per-attendee extraction is best-effort: emails are the stable signal,
// names/companies are present but unstructured (the order varies). We pull
// one ParticipantInput per email — the import path resolves and backfills
// from there.
const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
export function parseParticipantsText(text: string): ParticipantInput[] {
  const seen = new Set<string>();
  const out: ParticipantInput[] = [];
  let m: RegExpExecArray | null;
  EMAIL_RE.lastIndex = 0;
  while ((m = EMAIL_RE.exec(text)) !== null) {
    const email = m[0].toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({ email });
  }
  return out;
}

// Granola's `date` attribute is human-formatted ("May 6, 2026 1:45 PM CST").
// Node's Date constructor handles this on most platforms; if it doesn't, we
// keep the raw string so downstream parsing isn't blocked.
function toIso8601(raw: string): string | undefined {
  const d = new Date(raw);
  if (Number.isFinite(d.getTime())) return d.toISOString();
  return undefined;
}

function unwrapMeetingsList(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    for (const key of ["meetings", "results", "items", "data"]) {
      const v = r[key];
      if (Array.isArray(v)) return v as Record<string, unknown>[];
    }
    // Single meeting object — wrap it.
    if (typeof r.id === "string" || typeof r.meeting_id === "string") {
      return [r];
    }
  }
  return [];
}

function meetingMatchesId(
  m: Record<string, unknown>,
  meetingId: string,
): boolean {
  const candidates = [m.id, m.meeting_id, m.uuid];
  return candidates.some(
    (v) => typeof v === "string" && v.toLowerCase() === meetingId.toLowerCase(),
  );
}

function extractParticipants(
  meeting: Record<string, unknown>,
): ParticipantInput[] {
  const out: ParticipantInput[] = [];
  for (const key of ["participants", "attendees", "people"]) {
    const list = meeting[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const p = coerceParticipant(item);
      if (p) out.push(p);
    }
    if (out.length) return out;
  }
  return out;
}

function coerceParticipant(raw: unknown): ParticipantInput | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const p: ParticipantInput = {};
  const email = pickString(r, ["email", "email_address"]);
  if (email && email.includes("@")) p.email = email;
  const linkedin = pickString(r, [
    "linkedin_url",
    "linkedin",
    "linkedin_profile_url",
  ]);
  if (linkedin) p.linkedin_url = linkedin;
  const twitter = pickString(r, ["twitter_url", "twitter", "x_url"]);
  if (twitter) p.twitter_url = twitter;
  if (!p.email && !p.linkedin_url && !p.twitter_url) return null;
  return p;
}

function pickString(
  o: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim().length) return v.trim();
  }
  return undefined;
}

function pickNumber(
  o: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

function buildPayload(input: {
  meetingId: string;
  content: string;
  meeting: GranolaMeeting;
}): TranscriptPayload {
  return {
    source: GRANOLA_PROVIDER,
    source_id: input.meeting.id || input.meetingId,
    title: input.meeting.title,
    started_at: input.meeting.start,
    ended_at: input.meeting.end,
    duration_seconds: computeDuration(input.meeting),
    summary: input.meeting.summary,
    content: input.content,
    participants: input.meeting.participants,
  };
}

function computeDuration(m: GranolaMeeting): number | undefined {
  if (m.duration && Number.isFinite(m.duration)) return m.duration;
  if (m.start && m.end) {
    const s = Date.parse(m.start);
    const e = Date.parse(m.end);
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) {
      return Math.round((e - s) / 1000);
    }
  }
  return undefined;
}
