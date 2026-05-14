import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import type { Command } from "commander";
import type { Lix } from "@lix-js/sdk";
import { findWorkspace, openWorkspace } from "../workspace/open.js";
import { exec } from "../db/execute.js";
import { fail, setJsonMode } from "../output/json.js";
import { AcrmError, ERR } from "../lib/errors.js";

type Person = {
  id: string;
  name: string | null;
  job_title: string | null;
  linkedin_url: string | null;
  twitter_url: string | null;
  email: string | null;
  company_id: string | null;
};

type Company = {
  id: string;
  name: string | null;
  description: string | null;
};

type Deal = {
  id: string;
  name: string | null;
  stage: string | null;
  value: { amount: number; currency: string } | null;
  close_date: string | null;
  next_step: string | null;
  company_id: string | null;
};

type TranscriptItem = {
  id: string;
  title: string | null;
  started_at: string | null;
  other_participants: string[];
};

type TranscriptDetail = {
  id: string;
  title: string | null;
  started_at: string | null;
  summary: string | null;
  content: string | null;
  participants: { id: string; name: string | null }[];
};

type PostPlatform = "linkedin" | "x" | null;

type PostItem = {
  id: string;
  platform: PostPlatform;
  url: string | null;
  posted_at: string | null;
  content: string | null;
};


type Counts = { people: number; companies: number; deals: number };

async function loadPeople(lix: Lix): Promise<Person[]> {
  const r = await exec(
    lix,
    `SELECT
       p.record_id AS id,
       v_name.value_json AS name_json,
       v_role.value_json AS role_json,
       v_li.value_json AS li_json,
       v_tw.value_json AS tw_json,
       v_ref.ref_record_id AS company_id
     FROM acrm_record p
     LEFT JOIN acrm_value v_name
       ON v_name.record_id = p.record_id
       AND v_name.attribute_slug = 'name'
       AND v_name.active_until IS NULL
     LEFT JOIN acrm_value v_role
       ON v_role.record_id = p.record_id
       AND v_role.attribute_slug = 'job_title'
       AND v_role.active_until IS NULL
     LEFT JOIN acrm_value v_li
       ON v_li.record_id = p.record_id
       AND v_li.attribute_slug = 'linkedin_url'
       AND v_li.active_until IS NULL
     LEFT JOIN acrm_value v_tw
       ON v_tw.record_id = p.record_id
       AND v_tw.attribute_slug = 'twitter_url'
       AND v_tw.active_until IS NULL
     LEFT JOIN acrm_value v_ref
       ON v_ref.record_id = p.record_id
       AND v_ref.attribute_slug = 'company'
       AND v_ref.active_until IS NULL
     WHERE p.object_slug = 'people'`,
  );

  const emails = await exec(
    lix,
    `SELECT record_id, value_json
     FROM acrm_value
     WHERE object_slug = 'people'
       AND attribute_slug = 'email_addresses'
       AND active_until IS NULL`,
  );
  const emailByPerson = new Map<string, string>();
  for (const row of emails.rows) {
    const id = row.record_id as string;
    if (emailByPerson.has(id)) continue;
    const obj = parseJson(row.value_json);
    const e =
      (obj?.original_email_address as string | undefined) ??
      (obj?.email_address as string | undefined);
    if (e) emailByPerson.set(id, e);
  }

  const out: Person[] = r.rows.map((row) => {
    const nameObj = parseJson(row.name_json);
    const roleObj = parseJson(row.role_json);
    const liObj = parseJson(row.li_json);
    const twObj = parseJson(row.tw_json);
    const id = row.id as string;
    return {
      id,
      name: (nameObj?.full_name as string | undefined) ?? null,
      job_title: (roleObj?.value as string | undefined) ?? null,
      linkedin_url: (liObj?.value as string | undefined) ?? null,
      twitter_url: (twObj?.value as string | undefined) ?? null,
      email: emailByPerson.get(id) ?? null,
      company_id: (row.company_id as string | null) ?? null,
    };
  });
  out.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  return out;
}

async function loadDeals(lix: Lix): Promise<Deal[]> {
  const r = await exec(
    lix,
    `SELECT
       d.record_id AS id,
       v_name.value_json AS name_json,
       v_stage.value_json AS stage_json,
       v_val.value_json AS val_json,
       v_date.value_json AS date_json,
       v_step.value_json AS step_json,
       v_co.ref_record_id AS company_id
     FROM acrm_record d
     LEFT JOIN acrm_value v_name
       ON v_name.record_id = d.record_id
       AND v_name.attribute_slug = 'name'
       AND v_name.active_until IS NULL
     LEFT JOIN acrm_value v_stage
       ON v_stage.record_id = d.record_id
       AND v_stage.attribute_slug = 'stage'
       AND v_stage.active_until IS NULL
     LEFT JOIN acrm_value v_val
       ON v_val.record_id = d.record_id
       AND v_val.attribute_slug = 'value'
       AND v_val.active_until IS NULL
     LEFT JOIN acrm_value v_date
       ON v_date.record_id = d.record_id
       AND v_date.attribute_slug = 'close_date'
       AND v_date.active_until IS NULL
     LEFT JOIN acrm_value v_step
       ON v_step.record_id = d.record_id
       AND v_step.attribute_slug = 'next_step'
       AND v_step.active_until IS NULL
     LEFT JOIN acrm_value v_co
       ON v_co.record_id = d.record_id
       AND v_co.attribute_slug = 'associated_company'
       AND v_co.active_until IS NULL
     WHERE d.object_slug = 'deals'`,
  );
  const out: Deal[] = r.rows.map((row) => {
    const nameObj = parseJson(row.name_json);
    const stageObj = parseJson(row.stage_json);
    const valObj = parseJson(row.val_json);
    const dateObj = parseJson(row.date_json);
    const stepObj = parseJson(row.step_json);
    const amount = valObj?.currency_value;
    const currency = valObj?.currency_code;
    return {
      id: row.id as string,
      name: (nameObj?.value as string | undefined) ?? null,
      stage:
        (stageObj?.title as string | undefined) ??
        (stageObj?.id as string | undefined) ??
        null,
      value:
        typeof amount === "number"
          ? { amount, currency: (currency as string | undefined) ?? "USD" }
          : null,
      close_date: (dateObj?.date as string | undefined) ?? null,
      next_step: (stepObj?.value as string | undefined) ?? null,
      company_id: (row.company_id as string | null) ?? null,
    };
  });
  out.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  return out;
}

async function loadTranscriptsForPerson(
  lix: Lix,
  personId: string,
): Promise<TranscriptItem[]> {
  // Find transcripts where this person is a participant, joined with the
  // transcript's title and started_at.
  const r = await exec(
    lix,
    `SELECT
       t.record_id AS id,
       v_title.value_json AS title_json,
       v_started.value_json AS started_json
     FROM acrm_record t
     JOIN acrm_value v_part
       ON v_part.record_id = t.record_id
       AND v_part.object_slug = 'transcripts'
       AND v_part.attribute_slug = 'participants'
       AND v_part.ref_record_id = $1
       AND v_part.active_until IS NULL
     LEFT JOIN acrm_value v_title
       ON v_title.record_id = t.record_id
       AND v_title.attribute_slug = 'title'
       AND v_title.active_until IS NULL
     LEFT JOIN acrm_value v_started
       ON v_started.record_id = t.record_id
       AND v_started.attribute_slug = 'started_at'
       AND v_started.active_until IS NULL
     WHERE t.object_slug = 'transcripts'`,
    [personId],
  );
  const transcripts = r.rows.map((row) => {
    const titleObj = parseJson(row.title_json);
    const startedObj = parseJson(row.started_json);
    return {
      id: row.id as string,
      title: (titleObj?.value as string | undefined) ?? null,
      started_at: (startedObj?.timestamp as string | undefined) ?? null,
    };
  });
  if (transcripts.length === 0) return [];

  // For each transcript, fetch the other participants' names (everyone except
  // the focus person). Single query, then group in JS.
  const ids = transcripts.map((t) => t.id);
  const placeholders = ids.map((_, i) => `$${i + 2}`).join(",");
  const parts = await exec(
    lix,
    `SELECT
       v.record_id AS transcript_id,
       v.ref_record_id AS person_id,
       v_name.value_json AS name_json
     FROM acrm_value v
     LEFT JOIN acrm_value v_name
       ON v_name.record_id = v.ref_record_id
       AND v_name.object_slug = 'people'
       AND v_name.attribute_slug = 'name'
       AND v_name.active_until IS NULL
     WHERE v.object_slug = 'transcripts'
       AND v.attribute_slug = 'participants'
       AND v.active_until IS NULL
       AND v.ref_record_id <> $1
       AND v.record_id IN (${placeholders})`,
    [personId, ...ids],
  );
  const otherByTranscript = new Map<string, string[]>();
  for (const row of parts.rows) {
    const tid = row.transcript_id as string;
    const nameObj = parseJson(row.name_json);
    const name =
      (nameObj?.full_name as string | undefined) ??
      (nameObj?.first_name as string | undefined) ??
      null;
    if (!name) continue;
    const list = otherByTranscript.get(tid) ?? [];
    list.push(name);
    otherByTranscript.set(tid, list);
  }

  const out: TranscriptItem[] = transcripts.map((t) => ({
    ...t,
    other_participants: otherByTranscript.get(t.id) ?? [],
  }));
  // Reverse chronological. Nulls last.
  out.sort((a, b) => {
    if (a.started_at && b.started_at) {
      return b.started_at.localeCompare(a.started_at);
    }
    if (a.started_at) return -1;
    if (b.started_at) return 1;
    return 0;
  });
  return out;
}

async function loadTranscript(
  lix: Lix,
  transcriptId: string,
): Promise<TranscriptDetail | null> {
  const r = await exec(
    lix,
    `SELECT attribute_slug, value_json
     FROM acrm_value
     WHERE object_slug = 'transcripts'
       AND record_id = $1
       AND active_until IS NULL
       AND attribute_slug IN ('title','started_at','summary','content')`,
    [transcriptId],
  );
  if (r.rows.length === 0) {
    // Could still be a transcript with only participants set. Confirm record
    // exists before returning null.
    const exists = await exec(
      lix,
      `SELECT 1 AS x FROM acrm_record
       WHERE object_slug = 'transcripts' AND record_id = $1`,
      [transcriptId],
    );
    if (exists.rows.length === 0) return null;
  }
  let title: string | null = null;
  let started_at: string | null = null;
  let summary: string | null = null;
  let content: string | null = null;
  for (const row of r.rows) {
    const slug = row.attribute_slug as string;
    const obj = parseJson(row.value_json);
    if (slug === "title") title = (obj?.value as string | undefined) ?? null;
    else if (slug === "started_at")
      started_at = (obj?.timestamp as string | undefined) ?? null;
    else if (slug === "summary")
      summary = (obj?.value as string | undefined) ?? null;
    else if (slug === "content")
      content = (obj?.value as string | undefined) ?? null;
  }

  const parts = await exec(
    lix,
    `SELECT
       v.ref_record_id AS person_id,
       v_name.value_json AS name_json
     FROM acrm_value v
     LEFT JOIN acrm_value v_name
       ON v_name.record_id = v.ref_record_id
       AND v_name.object_slug = 'people'
       AND v_name.attribute_slug = 'name'
       AND v_name.active_until IS NULL
     WHERE v.object_slug = 'transcripts'
       AND v.record_id = $1
       AND v.attribute_slug = 'participants'
       AND v.active_until IS NULL`,
    [transcriptId],
  );
  const participants = parts.rows.map((row) => {
    const obj = parseJson(row.name_json);
    return {
      id: row.person_id as string,
      name:
        (obj?.full_name as string | undefined) ??
        (obj?.first_name as string | undefined) ??
        null,
    };
  });

  return { id: transcriptId, title, started_at, summary, content, participants };
}

function parsePlatform(v: unknown): PostPlatform {
  const obj = parseJson(v);
  const raw =
    (obj?.id as string | undefined) ?? (obj?.title as string | undefined) ?? null;
  if (!raw) return null;
  const norm = raw.toLowerCase();
  if (norm === "linkedin" || norm === "x") return norm;
  return null;
}

async function loadPostsForPerson(
  lix: Lix,
  personId: string,
): Promise<PostItem[]> {
  // Posts authored by this person. `author` is a single-valued
  // record-reference, so ref_record_id pins each post to one person.
  const r = await exec(
    lix,
    `SELECT
       p.record_id AS id,
       v_url.value_json AS url_json,
       v_plat.value_json AS plat_json,
       v_posted.value_json AS posted_json,
       v_content.value_json AS content_json
     FROM acrm_record p
     JOIN acrm_value v_author
       ON v_author.record_id = p.record_id
       AND v_author.object_slug = 'posts'
       AND v_author.attribute_slug = 'author'
       AND v_author.ref_record_id = $1
       AND v_author.active_until IS NULL
     LEFT JOIN acrm_value v_url
       ON v_url.record_id = p.record_id
       AND v_url.attribute_slug = 'url'
       AND v_url.active_until IS NULL
     LEFT JOIN acrm_value v_plat
       ON v_plat.record_id = p.record_id
       AND v_plat.attribute_slug = 'platform'
       AND v_plat.active_until IS NULL
     LEFT JOIN acrm_value v_posted
       ON v_posted.record_id = p.record_id
       AND v_posted.attribute_slug = 'posted_at'
       AND v_posted.active_until IS NULL
     LEFT JOIN acrm_value v_content
       ON v_content.record_id = p.record_id
       AND v_content.attribute_slug = 'content'
       AND v_content.active_until IS NULL
     WHERE p.object_slug = 'posts'`,
    [personId],
  );

  const out: PostItem[] = r.rows.map((row) => {
    const urlObj = parseJson(row.url_json);
    const postedObj = parseJson(row.posted_json);
    const contentObj = parseJson(row.content_json);
    return {
      id: row.id as string,
      platform: parsePlatform(row.plat_json),
      url: (urlObj?.value as string | undefined) ?? null,
      posted_at: (postedObj?.date as string | undefined) ?? null,
      content: (contentObj?.value as string | undefined) ?? null,
    };
  });

  // Reverse chronological by posted_at (YYYY-MM-DD). Nulls last.
  out.sort((a, b) => {
    if (a.posted_at && b.posted_at) {
      return b.posted_at.localeCompare(a.posted_at);
    }
    if (a.posted_at) return -1;
    if (b.posted_at) return 1;
    return 0;
  });
  return out;
}

function postExternalUrl(rawUrl: string | null): string | null {
  if (!rawUrl) return null;
  if (/^https?:\/\//i.test(rawUrl)) return rawUrl;
  return `https://${rawUrl}`;
}

function xEmbedTargetUrl(rawUrl: string | null): string | null {
  if (!rawUrl) return null;
  const m = /(?:x\.com|twitter\.com)\/([^/?#]+)\/status\/(\d+)/i.exec(rawUrl);
  if (!m) return null;
  return `https://twitter.com/${m[1]}/status/${m[2]}`;
}

function linkedinEmbedUrl(rawUrl: string | null): string | null {
  if (!rawUrl) return null;
  const m = /urn:li:(activity|share|ugcPost):(\d+)/i.exec(rawUrl);
  if (!m) return null;
  return `https://www.linkedin.com/embed/feed/update/urn:li:${m[1]}:${m[2]}`;
}

async function loadCompanies(lix: Lix): Promise<Company[]> {
  const r = await exec(
    lix,
    `SELECT
       c.record_id AS id,
       v_name.value_json AS name_json,
       v_desc.value_json AS desc_json
     FROM acrm_record c
     LEFT JOIN acrm_value v_name
       ON v_name.record_id = c.record_id
       AND v_name.attribute_slug = 'name'
       AND v_name.active_until IS NULL
     LEFT JOIN acrm_value v_desc
       ON v_desc.record_id = c.record_id
       AND v_desc.attribute_slug = 'description'
       AND v_desc.active_until IS NULL
     WHERE c.object_slug = 'companies'`,
  );
  const out: Company[] = r.rows.map((row) => {
    const nameObj = parseJson(row.name_json);
    const descObj = parseJson(row.desc_json);
    return {
      id: row.id as string,
      name: (nameObj?.value as string | undefined) ?? null,
      description: (descObj?.value as string | undefined) ?? null,
    };
  });
  out.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  return out;
}

async function loadCounts(lix: Lix): Promise<Counts> {
  const r = await exec(
    lix,
    `SELECT object_slug, COUNT(*) AS n FROM acrm_record GROUP BY object_slug`,
  );
  const counts: Counts = { people: 0, companies: 0, deals: 0 };
  for (const row of r.rows) {
    const slug = row.object_slug as string;
    const n = Number(row.n);
    if (slug === "people") counts.people = n;
    else if (slug === "companies") counts.companies = n;
    else if (slug === "deals") counts.deals = n;
  }
  return counts;
}

function parseJson(v: unknown): Record<string, unknown> | null {
  if (typeof v !== "string" || !v.length) return null;
  try {
    return JSON.parse(v) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 38%, 32%)`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

const STYLES = `
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; height: 100%; }
body {
  font-family: "Inter", -apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif;
  font-size: 13px;
  line-height: 1.45;
  background: #0a0a0a;
  color: #e6e6e6;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  letter-spacing: -0.005em;
}
.app { display: grid; grid-template-columns: 220px 1fr; height: 100vh; }
.sidebar {
  background: #0a0a0a;
  border-right: 1px solid rgba(255,255,255,0.06);
  padding: 14px 8px;
  overflow-y: auto;
}
.workspace {
  padding: 4px 10px 14px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: #ededed;
}
.workspace-icon {
  width: 18px; height: 18px;
  border-radius: 5px;
  background: linear-gradient(135deg, #5e6ad2 0%, #4a8af4 100%);
  flex: none;
}
.nav-section { margin-top: 10px; }
.nav-label {
  font-size: 11px;
  color: #6a6a6a;
  padding: 4px 10px 6px;
  font-weight: 500;
}
.nav-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 10px;
  border-radius: 5px;
  color: #c0c0c0;
  text-decoration: none;
  font-size: 13px;
}
.nav-item:hover { background: rgba(255,255,255,0.04); color: #e6e6e6; }
.nav-item.active { background: rgba(255,255,255,0.06); color: #fff; }
.nav-item .left { display: flex; align-items: center; gap: 8px; }
.nav-item .icon { width: 14px; height: 14px; opacity: 0.75; flex: none; }
.nav-item.active .icon { opacity: 1; }
.nav-item .count { font-size: 11px; color: #6a6a6a; font-variant-numeric: tabular-nums; }
.main { overflow: auto; }
.topbar {
  height: 48px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  display: flex;
  align-items: center;
  padding: 0 24px;
  gap: 10px;
  position: sticky;
  top: 0;
  background: #0a0a0a;
  z-index: 1;
}
.topbar h1 { font-size: 13px; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
.topbar .count {
  font-size: 12px;
  color: #6a6a6a;
  font-variant-numeric: tabular-nums;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
thead tr { border-bottom: 1px solid rgba(255,255,255,0.06); }
th {
  text-align: left;
  font-weight: 500;
  color: #8a8a8a;
  font-size: 12px;
  padding: 10px 16px;
  background: #0a0a0a;
  position: sticky;
  top: 48px;
  z-index: 1;
}
tbody tr { border-bottom: 1px solid rgba(255,255,255,0.04); }
tbody tr:last-child { border-bottom: none; }
tbody tr:hover { background: rgba(255,255,255,0.025); }
td {
  padding: 10px 16px;
  color: #d8d8d8;
  vertical-align: middle;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 360px;
}
td.muted { color: #555; }
.avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px; height: 22px;
  border-radius: 50%;
  color: rgba(255,255,255,0.95);
  font-size: 10px;
  font-weight: 600;
  margin-right: 10px;
  vertical-align: middle;
  flex: none;
}
.name-cell { display: flex; align-items: center; min-width: 0; }
.name-cell span:last-child { overflow: hidden; text-overflow: ellipsis; }
a { color: #6e9fff; text-decoration: none; }
a:hover { text-decoration: underline; }
.mono {
  font-family: "JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace;
  font-size: 12px;
  color: #9a9a9a;
}
.empty {
  padding: 80px 40px;
  text-align: center;
  color: #6a6a6a;
}
.empty h2 { font-size: 14px; font-weight: 500; color: #a0a0a0; margin: 0 0 6px; }
.empty p { margin: 0; font-size: 12px; }
.row-link { color: inherit; display: flex; align-items: center; min-width: 0; }
.row-link:hover { text-decoration: none; }
tbody tr.clickable { cursor: pointer; }
.detail { max-width: 720px; margin: 0 auto; padding: 40px 32px 80px; }
.hero { display: flex; align-items: center; gap: 16px; margin-bottom: 18px; }
.hero .avatar {
  width: 44px; height: 44px;
  font-size: 16px;
  margin: 0;
}
.hero h1 {
  font-size: 26px;
  font-weight: 600;
  letter-spacing: -0.02em;
  margin: 0;
  color: #f0f0f0;
}
.contact { display: flex; flex-direction: column; gap: 6px; margin-bottom: 36px; }
.contact-row { display: flex; align-items: center; gap: 10px; font-size: 13px; color: #b0b0b0; }
.contact-row .field-icon { width: 14px; height: 14px; color: #6a6a6a; flex: none; }
.contact-row a { color: #b0b0b0; }
.contact-row a:hover { color: #e6e6e6; text-decoration: underline; }
.section-divider {
  border-top: 1px solid rgba(255,255,255,0.06);
  margin: 8px 0 28px;
}
.timeline-empty { color: #6a6a6a; font-size: 13px; padding: 8px 0; }
.timeline-group { margin-bottom: 24px; }
.timeline-group-label {
  font-size: 12px;
  color: #6a6a6a;
  margin: 0 0 10px;
  font-weight: 500;
}
.timeline-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 8px;
  border-radius: 6px;
  color: inherit;
}
.timeline-item:hover { background: rgba(255,255,255,0.03); text-decoration: none; }
.timeline-item .avatar { margin: 0; width: 26px; height: 26px; font-size: 11px; }
.timeline-item .body { flex: 1; min-width: 0; }
.timeline-item .title {
  font-size: 14px;
  color: #e6e6e6;
  margin: 0 0 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.timeline-item .sub {
  font-size: 12px;
  color: #7a7a7a;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.timeline-item .time {
  font-size: 12px;
  color: #7a7a7a;
  font-variant-numeric: tabular-nums;
  flex: none;
}
.person-toggle { margin: 0 0 20px; }
.post-embed {
  margin: 0 0 14px;
  max-width: 550px;
  border-radius: 12px;
  overflow: hidden;
}
.post-embed.li-embed {
  background: #ffffff;
  border: 1px solid rgba(255,255,255,0.06);
}
.post-embed.li-embed iframe {
  display: block;
  width: 100%;
  height: 640px;
  border: 0;
}
.post-embed.x-embed {
  /* widgets.js injects its own iframe; we just constrain width */
}
.post-embed.x-embed .twitter-tweet { margin: 0 !important; }
.post-fallback {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 10px;
  max-width: 550px;
  margin: 0 0 14px;
  color: inherit;
}
.post-fallback:hover { background: rgba(255,255,255,0.03); text-decoration: none; }
.post-fallback .avatar { margin: 0; width: 28px; height: 28px; font-size: 11px; flex: none; }
.post-fallback .body { flex: 1; min-width: 0; }
.post-fallback .title {
  font-size: 13px;
  color: #e6e6e6;
  margin: 0 0 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.post-fallback .sub { font-size: 12px; color: #7a7a7a; }
.transcript-detail { max-width: 760px; margin: 0 auto; padding: 56px 32px 80px; }
.transcript-title {
  font-family: "New York", "Iowan Old Style", Georgia, "Times New Roman", serif;
  font-size: 34px;
  font-weight: 500;
  letter-spacing: -0.02em;
  margin: 0 0 18px;
  color: #f0f0f0;
}
.pill-row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 28px; }
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 11px;
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 999px;
  font-size: 12px;
  color: #b0b0b0;
  background: transparent;
}
.pill .field-icon { width: 13px; height: 13px; color: #8a8a8a; }
.view-toggle {
  display: inline-flex;
  padding: 3px;
  background: rgba(255,255,255,0.04);
  border-radius: 999px;
  margin-bottom: 24px;
}
.view-toggle button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: 0;
  color: #8a8a8a;
  font: inherit;
  font-size: 12px;
  padding: 6px 14px;
  border-radius: 999px;
  cursor: pointer;
}
.view-toggle button:hover { color: #d0d0d0; }
.view-toggle button.active {
  background: rgba(255,255,255,0.08);
  color: #f0f0f0;
}
.view-toggle .field-icon { width: 14px; height: 14px; color: currentColor; }
.prose {
  font-size: 14px;
  color: #d0d0d0;
  line-height: 1.6;
}
.prose h2 {
  display: flex;
  gap: 10px;
  font-size: 15px;
  font-weight: 600;
  color: #e6e6e6;
  margin: 28px 0 10px;
}
.prose h2::before { content: "#"; color: #5a5a5a; font-weight: 400; }
.prose h3 {
  font-size: 14px;
  font-weight: 600;
  color: #d8d8d8;
  margin: 18px 0 8px;
}
.prose ul { margin: 6px 0 6px 4px; padding-left: 20px; }
.prose li { margin: 4px 0; }
.prose p { margin: 8px 0; }
.prose .raw {
  white-space: pre-wrap;
  font-family: "JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace;
  font-size: 13px;
  color: #c0c0c0;
}
.prose .empty-view { color: #6a6a6a; font-size: 13px; }
.prose .turn { margin: 0 0 18px; }
.prose .turn:last-child { margin-bottom: 0; }
.prose .speaker {
  font-size: 12px;
  font-weight: 600;
  color: #9a9a9a;
  margin: 0 0 4px;
  letter-spacing: 0.01em;
}
.prose .utterance { color: #d8d8d8; white-space: pre-wrap; }
.prose code {
  font-family: "JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace;
  font-size: 12px;
  background: rgba(255,255,255,0.06);
  color: #e0e0e0;
  padding: 1px 5px;
  border-radius: 3px;
}
.back-button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 11px 5px 8px;
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 999px;
  margin-bottom: 22px;
  color: #b0b0b0;
}
.back-button:hover { color: #e6e6e6; background: rgba(255,255,255,0.04); text-decoration: none; }
.back-button .icon, .back-button .field-icon { width: 14px; height: 14px; color: currentColor; opacity: 1; }
`;

const ICON_PEOPLE = `<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="6" r="2.5"/><path d="M3 13c0-2.5 2.2-4 5-4s5 1.5 5 4"/></svg>`;
const ICON_COMPANIES = `<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="3" width="10" height="10" rx="1"/><path d="M6 6h1M9 6h1M6 9h1M9 9h1"/></svg>`;
const ICON_DEALS = `<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="6"/><path d="M8 4.5v7M10 6.25c0-.83-.9-1.5-2-1.5s-2 .67-2 1.5.9 1.25 2 1.5 2 .67 2 1.5-.9 1.5-2 1.5-2-.67-2-1.5"/></svg>`;
const ICON_MAIL = `<svg class="field-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="3.5" width="12" height="9" rx="1.5"/><path d="M2.5 4.5l5.5 4 5.5-4"/></svg>`;
const ICON_LINKEDIN = `<svg class="field-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M3.6 5.5h2.2v7H3.6v-7zm1.1-3.2a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6zM7.3 5.5h2.1v1h.03c.3-.55 1.03-1.13 2.12-1.13 2.27 0 2.69 1.49 2.69 3.43V12.5h-2.23V9.27c0-.77-.01-1.76-1.07-1.76-1.07 0-1.24.84-1.24 1.7V12.5H7.3v-7z"/></svg>`;
const ICON_X = `<svg class="field-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M11.7 2.5h2.05L9.27 7.62 14.5 13.5h-4.13L7.13 9.66 3.4 13.5H1.35l4.78-5.47L1.1 2.5h4.23l2.92 3.5 3.45-3.5zm-.72 9.78h1.14L4.97 3.66H3.75l7.23 8.62z"/></svg>`;
const ICON_CALENDAR = `<svg class="field-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M5 2v3M11 2v3M2.5 7h11"/></svg>`;
const ICON_USERS = `<svg class="field-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="6" cy="6" r="2.3"/><path d="M2 13c0-2.3 1.8-3.6 4-3.6s4 1.3 4 3.6"/><circle cx="11.3" cy="6.5" r="1.9"/><path d="M10 9.6c1.5 0 4 .9 4 3"/></svg>`;
const ICON_SUMMARY = `<svg class="field-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 5h10M3 8h10M3 11h6"/></svg>`;
const ICON_TRANSCRIPT = `<svg class="field-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 3.5h10v7H6.5L3.5 13V3.5z" stroke-linejoin="round"/><path d="M5.5 6h5M5.5 8h3" stroke-linecap="round"/></svg>`;
const ICON_POST = `<svg class="field-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M5 5.5h6M5 8h6M5 10.5h4" stroke-linecap="round"/></svg>`;

function renderShell(opts: {
  workspace: string;
  active: "people" | "companies" | "deals";
  counts: Counts;
  body: string;
}): string {
  const { workspace, active, counts, body } = opts;
  const navItem = (
    href: string,
    key: "people" | "companies" | "deals",
    label: string,
    icon: string,
    count: number,
  ) => `<a class="nav-item ${active === key ? "active" : ""}" href="${href}">
    <span class="left">${icon}<span>${label}</span></span>
    <span class="count">${count}</span>
  </a>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(workspace)} — Agent CRM</title>
<style>${STYLES}</style>
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="workspace">
      <span class="workspace-icon"></span>
      <span>${escapeHtml(workspace)}</span>
    </div>
    <div class="nav-section">
      <div class="nav-label">Objects</div>
      ${navItem("/people", "people", "People", ICON_PEOPLE, counts.people)}
      ${navItem("/companies", "companies", "Companies", ICON_COMPANIES, counts.companies)}
      ${navItem("/deals", "deals", "Deals", ICON_DEALS, counts.deals)}
    </div>
  </aside>
  <main class="main">${body}</main>
</div>
<script>
  document.addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    const tr = e.target.closest('tr.clickable');
    if (tr && tr.dataset.href) window.location.href = tr.dataset.href;
  });
</script>
</body>
</html>`;
}

function renderPeoplePage(
  people: Person[],
  companyById: Map<string, string>,
  workspace: string,
  counts: Counts,
): string {
  const rows = people
    .map((p) => {
      const display = p.name ?? "(unnamed)";
      const color = avatarColor(p.id);
      const company =
        p.company_id && companyById.get(p.company_id)
          ? escapeHtml(companyById.get(p.company_id)!)
          : `<span class="muted">—</span>`;
      const role = p.job_title
        ? escapeHtml(p.job_title)
        : `<span class="muted">—</span>`;
      const linkedin = p.linkedin_url
        ? `<a class="mono" href="https://${escapeHtml(p.linkedin_url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(p.linkedin_url)}</a>`
        : `<span class="muted">—</span>`;
      const email = p.email
        ? `<a class="mono" href="mailto:${escapeHtml(p.email)}">${escapeHtml(p.email)}</a>`
        : `<span class="muted">—</span>`;
      const x = p.twitter_url
        ? `<a class="mono" href="https://${escapeHtml(p.twitter_url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(p.twitter_url)}</a>`
        : `<span class="muted">—</span>`;
      const href = `/people/${encodeURIComponent(p.id)}`;
      return `<tr class="clickable" data-href="${href}">
        <td><a class="row-link" href="${href}"><span class="avatar" style="background:${color}">${escapeHtml(initials(display))}</span><span>${escapeHtml(display)}</span></a></td>
        <td>${role}</td>
        <td>${email}</td>
        <td>${company}</td>
        <td>${linkedin}</td>
        <td>${x}</td>
      </tr>`;
    })
    .join("");

  const body = `
    <div class="topbar">
      <h1>People</h1>
      <span class="count">${people.length}</span>
    </div>
    ${
      people.length
        ? `<table>
          <thead><tr><th>Name</th><th>Role</th><th>Email</th><th>Company</th><th>LinkedIn</th><th>X</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`
        : `<div class="empty"><h2>No people yet</h2><p>Run <span class="mono">acrm import csv ./leads.csv</span> to add some.</p></div>`
    }
  `;
  return renderShell({ workspace, active: "people", counts, body });
}

function renderCompaniesPage(
  companies: Company[],
  peopleByCompany: Map<string, number>,
  workspace: string,
  counts: Counts,
): string {
  const rows = companies
    .map((c) => {
      const display = c.name ?? "(unnamed)";
      const color = avatarColor(c.id);
      const desc = c.description
        ? escapeHtml(c.description)
        : `<span class="muted">—</span>`;
      const headcount = peopleByCompany.get(c.id) ?? 0;
      return `<tr>
        <td><div class="name-cell"><span class="avatar" style="background:${color}">${escapeHtml(initials(display))}</span><span>${escapeHtml(display)}</span></div></td>
        <td>${desc}</td>
        <td>${headcount === 0 ? `<span class="muted">0</span>` : headcount}</td>
      </tr>`;
    })
    .join("");

  const body = `
    <div class="topbar">
      <h1>Companies</h1>
      <span class="count">${companies.length}</span>
    </div>
    ${
      companies.length
        ? `<table>
          <thead><tr><th>Name</th><th>Description</th><th>People</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`
        : `<div class="empty"><h2>No companies yet</h2><p>Run <span class="mono">acrm import csv ./leads.csv</span> to add some.</p></div>`
    }
  `;
  return renderShell({ workspace, active: "companies", counts, body });
}

function formatCurrency(v: { amount: number; currency: string }): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: v.currency,
      maximumFractionDigits: 0,
    }).format(v.amount);
  } catch {
    return `${v.amount} ${v.currency}`;
  }
}

function renderDealsPage(
  deals: Deal[],
  companyById: Map<string, string>,
  workspace: string,
  counts: Counts,
): string {
  const rows = deals
    .map((d) => {
      const display = d.name ?? "(unnamed)";
      const color = avatarColor(d.id);
      const stage = d.stage
        ? escapeHtml(d.stage)
        : `<span class="muted">—</span>`;
      const value = d.value
        ? escapeHtml(formatCurrency(d.value))
        : `<span class="muted">—</span>`;
      const company =
        d.company_id && companyById.get(d.company_id)
          ? escapeHtml(companyById.get(d.company_id)!)
          : `<span class="muted">—</span>`;
      const closeDate = d.close_date
        ? escapeHtml(d.close_date)
        : `<span class="muted">—</span>`;
      const nextStep = d.next_step
        ? escapeHtml(d.next_step)
        : `<span class="muted">—</span>`;
      return `<tr>
        <td><div class="name-cell"><span class="avatar" style="background:${color}">${escapeHtml(initials(display))}</span><span>${escapeHtml(display)}</span></div></td>
        <td>${stage}</td>
        <td>${value}</td>
        <td>${company}</td>
        <td>${closeDate}</td>
        <td>${nextStep}</td>
      </tr>`;
    })
    .join("");

  const body = `
    <div class="topbar">
      <h1>Deals</h1>
      <span class="count">${deals.length}</span>
    </div>
    ${
      deals.length
        ? `<table>
          <thead><tr><th>Name</th><th>Stage</th><th>Value</th><th>Company</th><th>Close date</th><th>Next step</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`
        : `<div class="empty"><h2>No deals yet</h2><p>Deals appear here once imported or created.</p></div>`
    }
  `;
  return renderShell({ workspace, active: "deals", counts, body });
}

function parseDateOrTimestamp(iso: string): Date {
  // Bare YYYY-MM-DD must be parsed as local time, not UTC midnight — otherwise
  // negative UTC offsets shift the day backwards (e.g., CST sees "today" as
  // "yesterday").
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(iso);
}

function dateGroupLabel(iso: string, now: Date): string {
  const d = parseDateOrTimestamp(iso);
  if (Number.isNaN(d.getTime())) return "Undated";
  const startOfDay = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

function timeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d
    .toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    })
    .replace(/\s?(AM|PM)/i, (_, p) => " " + p.toLowerCase());
}

function platformLabel(p: PostPlatform): string {
  if (p === "linkedin") return "LinkedIn";
  if (p === "x") return "X";
  return "Post";
}

function postSnippet(content: string | null, max = 90): string {
  if (!content) return "";
  const collapsed = content.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

function renderPersonPage(opts: {
  workspace: string;
  counts: Counts;
  person: Person;
  companyName: string | null;
  transcripts: TranscriptItem[];
  posts: PostItem[];
}): string {
  const { workspace, counts, person, companyName, transcripts, posts } = opts;
  const display = person.name ?? "(unnamed)";
  const color = avatarColor(person.id);

  const contactRows: string[] = [];
  if (person.email) {
    contactRows.push(
      `<div class="contact-row">${ICON_MAIL}<a href="mailto:${escapeHtml(person.email)}">${escapeHtml(person.email)}</a></div>`,
    );
  }
  if (person.linkedin_url) {
    contactRows.push(
      `<div class="contact-row">${ICON_LINKEDIN}<a href="https://${escapeHtml(person.linkedin_url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(person.linkedin_url)}</a></div>`,
    );
  }
  if (person.twitter_url) {
    contactRows.push(
      `<div class="contact-row">${ICON_X}<a href="https://${escapeHtml(person.twitter_url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(person.twitter_url)}</a></div>`,
    );
  }
  if (person.job_title || companyName) {
    const bits = [person.job_title, companyName].filter(Boolean) as string[];
    contactRows.push(
      `<div class="contact-row" style="color:#9a9a9a">${bits.map(escapeHtml).join(" · ")}</div>`,
    );
  }

  const now = new Date();
  const backHref = `/people/${encodeURIComponent(person.id)}`;

  const transcriptGroups: { label: string; items: TranscriptItem[] }[] = [];
  for (const t of transcripts) {
    const label = t.started_at ? dateGroupLabel(t.started_at, now) : "Undated";
    const last = transcriptGroups[transcriptGroups.length - 1];
    if (last && last.label === label) last.items.push(t);
    else transcriptGroups.push({ label, items: [t] });
  }

  const renderTranscriptItem = (t: TranscriptItem): string => {
    const title = t.title ?? "(untitled transcript)";
    const sub =
      t.other_participants.length === 0
        ? display
        : t.other_participants.length <= 3
          ? t.other_participants.join(", ")
          : `${t.other_participants.slice(0, 2).join(", ")} & ${t.other_participants.length - 2} others`;
    const itemColor = avatarColor(t.id);
    const time = t.started_at ? timeLabel(t.started_at) : "";
    return `<a class="timeline-item" href="/transcripts/${encodeURIComponent(t.id)}?back=${encodeURIComponent(backHref)}">
      <span class="avatar" style="background:${itemColor}">${escapeHtml(initials(title))}</span>
      <div class="body">
        <div class="title">${escapeHtml(title)}</div>
        <div class="sub">${escapeHtml(sub)}</div>
      </div>
      <span class="time">${escapeHtml(time)}</span>
    </a>`;
  };

  const transcriptTimeline = transcriptGroups.length
    ? transcriptGroups
        .map(
          (g) => `<div class="timeline-group">
            <div class="timeline-group-label">${escapeHtml(g.label)}</div>
            ${g.items.map(renderTranscriptItem).join("")}
          </div>`,
        )
        .join("")
    : `<div class="timeline-empty">No transcripts associated with this person yet.</div>`;

  const postGroups: { label: string; items: PostItem[] }[] = [];
  for (const p of posts) {
    const label = p.posted_at ? dateGroupLabel(p.posted_at, now) : "Undated";
    const last = postGroups[postGroups.length - 1];
    if (last && last.label === label) last.items.push(p);
    else postGroups.push({ label, items: [p] });
  }

  const renderPostItem = (p: PostItem): string => {
    const externalUrl = postExternalUrl(p.url);
    if (p.platform === "x") {
      const tweetUrl = xEmbedTargetUrl(p.url) ?? externalUrl;
      if (tweetUrl) {
        return `<div class="post-embed x-embed">
          <blockquote class="twitter-tweet" data-theme="dark" data-dnt="true">
            <a href="${escapeHtml(tweetUrl)}"></a>
          </blockquote>
        </div>`;
      }
    }
    if (p.platform === "linkedin") {
      const embed = linkedinEmbedUrl(p.url);
      if (embed) {
        return `<div class="post-embed li-embed">
          <iframe src="${escapeHtml(embed)}" title="Embedded LinkedIn post" loading="lazy" allowfullscreen></iframe>
        </div>`;
      }
    }
    // Fallback when we don't have enough info to embed.
    const platform = platformLabel(p.platform);
    const title = postSnippet(p.content) || externalUrl || `${platform} post`;
    const avatarText =
      p.platform === "x" ? "X" : p.platform === "linkedin" ? "in" : initials(title);
    const href = externalUrl ?? "#";
    return `<a class="post-fallback" href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener">
      <span class="avatar" style="background:${avatarColor(p.id)}">${escapeHtml(avatarText)}</span>
      <div class="body">
        <div class="title">${escapeHtml(title)}</div>
        <div class="sub">${escapeHtml(platform)}</div>
      </div>
    </a>`;
  };

  const postsTimeline = postGroups.length
    ? postGroups
        .map(
          (g) => `<div class="timeline-group">
            <div class="timeline-group-label">${escapeHtml(g.label)}</div>
            ${g.items.map(renderPostItem).join("")}
          </div>`,
        )
        .join("")
    : `<div class="timeline-empty">No posts associated with this person yet.</div>`;

  const hasXPosts = posts.some((p) => p.platform === "x");
  const xWidgetScript = hasXPosts
    ? `<script async src="https://platform.twitter.com/widgets.js" charset="utf-8"></script>`
    : "";

  const body = `
    <div class="detail">
      <div class="hero">
        <span class="avatar" style="background:${color}">${escapeHtml(initials(display))}</span>
        <h1>${escapeHtml(display)}</h1>
      </div>
      <div class="contact">${contactRows.join("")}</div>
      <div class="section-divider"></div>
      <div class="view-toggle person-toggle" role="tablist">
        <button type="button" class="active" data-view="transcripts">${ICON_TRANSCRIPT}<span>Transcripts</span><span class="count" style="margin-left:6px;color:#6a6a6a">${transcripts.length}</span></button>
        <button type="button" data-view="posts">${ICON_POST}<span>Posts</span><span class="count" style="margin-left:6px;color:#6a6a6a">${posts.length}</span></button>
      </div>
      <div data-pane="transcripts">${transcriptTimeline}</div>
      <div data-pane="posts" style="display:none">${postsTimeline}</div>
    </div>
    ${xWidgetScript}
    <script>
      (() => {
        const tabs = document.querySelectorAll('.person-toggle button');
        const panes = document.querySelectorAll('[data-pane]');
        tabs.forEach((btn) => btn.addEventListener('click', () => {
          const view = btn.dataset.view;
          tabs.forEach((b) => b.classList.toggle('active', b === btn));
          panes.forEach((p) => {
            p.style.display = p.dataset.pane === view ? '' : 'none';
          });
          if (view === 'posts' && window.twttr && window.twttr.widgets) {
            window.twttr.widgets.load(document.querySelector('[data-pane="posts"]'));
          }
        }));
      })();
    </script>
  `;
  return renderShell({ workspace, active: "people", counts, body });
}

function fullDateLabel(iso: string, now: Date): string {
  const base = dateGroupLabel(iso, now);
  if (base === "Today" || base === "Yesterday") return base;
  return base;
}

function renderInline(text: string): string {
  // Inline markdown: bold (**...**), italic (*...* or _..._), code (`...`).
  // Escape first, then re-substitute inline patterns.
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");
  return s;
}

function renderMarkdownLite(text: string): string {
  // Minimal markdown for summaries that come back as markdown (Granola, manual
  // paste). Supports headings #..######, ordered/unordered lists with indent
  // nesting, inline bold/italic/code, and paragraphs.
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  type ListFrame = { indent: number; tag: "ul" | "ol" };
  const stack: ListFrame[] = [];
  const closeAllLists = () => {
    while (stack.length) {
      out.push("</li>");
      out.push(`</${stack[stack.length - 1]!.tag}>`);
      stack.pop();
    }
  };
  let inPara = false;
  const closePara = () => {
    if (inPara) {
      out.push("</p>");
      inPara = false;
    }
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "") {
      closePara();
      closeAllLists();
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    const bullet = /^(\s*)[-*•]\s+(.+)$/.exec(line);
    const numbered = /^(\s*)\d+\.\s+(.+)$/.exec(line);
    if (heading) {
      closePara();
      closeAllLists();
      const level = Math.min(heading[1]!.length, 4);
      // We use h2/h3/h4 visually (h1 is reserved for the page title).
      const tag = level === 1 ? "h2" : level === 2 ? "h2" : level === 3 ? "h3" : "h4";
      out.push(`<${tag}>${renderInline(heading[2]!)}</${tag}>`);
      continue;
    }
    if (bullet || numbered) {
      closePara();
      const m = (bullet ?? numbered)!;
      const indent = m[1]!.length;
      const tag: "ul" | "ol" = numbered ? "ol" : "ul";
      // Pop deeper frames. Close the open <li> inside the nested list, then
      // its <ul>/<ol>. After popping we're back inside the parent's open <li>.
      while (stack.length && stack[stack.length - 1]!.indent > indent) {
        out.push("</li>");
        out.push(`</${stack[stack.length - 1]!.tag}>`);
        stack.pop();
      }
      const top = stack[stack.length - 1];
      if (!top || top.indent < indent) {
        // Open a nested list inside the previous <li> (don't close it).
        out.push(`<${tag}>`);
        stack.push({ indent, tag });
      } else {
        // Same level: close previous <li>, start a new one.
        out.push("</li>");
      }
      out.push(`<li>${renderInline(m[2]!)}`);
      continue;
    }
    closeAllLists();
    if (!inPara) {
      out.push("<p>");
      inPara = true;
    } else {
      out.push(" ");
    }
    out.push(renderInline(line));
  }
  closePara();
  closeAllLists();
  return out.join("");
}

function renderTranscriptText(text: string): string {
  const t = text.replace(/\r\n?/g, "\n").trim();
  if (!t) return "";
  // Detect speaker turns. A speaker tag looks like "Name:" or "First Last:"
  // at the start of the text, after a newline, or after a sentence boundary.
  const re = /([A-Z][\w'’-]{0,40}(?:\s[A-Z][\w'’-]{0,40})?):\s/g;
  type Turn = { idx: number; end: number; speaker: string };
  const turns: Turn[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    let validStart = m.index === 0;
    if (!validStart) {
      // Walk backward across whitespace; the speaker tag is a turn start if
      // the first non-whitespace character we hit is a newline or a sentence
      // terminator (.!?). This handles Granola's two-space convention.
      let k = m.index - 1;
      while (k >= 0 && (t[k] === " " || t[k] === "\t")) k--;
      if (k < 0) validStart = true;
      else if (t[k] === "\n") validStart = true;
      else if (/[.!?]/.test(t[k]!)) validStart = true;
    }
    if (!validStart) continue;
    turns.push({
      idx: m.index,
      end: m.index + m[0].length,
      speaker: m[1]!,
    });
  }
  if (turns.length === 0) {
    // No speaker tags detected — fall back to pre-wrap so existing line breaks
    // (if any) are still preserved.
    return `<div class="raw">${escapeHtml(t)}</div>`;
  }
  const parts: string[] = [];
  for (let i = 0; i < turns.length; i++) {
    const cur = turns[i]!;
    const next = turns[i + 1];
    const utterance = t.slice(cur.end, next ? next.idx : t.length).trim();
    if (!utterance && !cur.speaker) continue;
    parts.push(
      `<div class="turn"><div class="speaker">${escapeHtml(cur.speaker)}</div><div class="utterance">${escapeHtml(utterance)}</div></div>`,
    );
  }
  return parts.join("");
}

function renderTranscriptPage(opts: {
  workspace: string;
  counts: Counts;
  transcript: TranscriptDetail;
  backHref: string;
}): string {
  const { workspace, counts, transcript, backHref } = opts;
  const display = transcript.title ?? "(untitled transcript)";
  const now = new Date();

  const pills: string[] = [];
  if (transcript.started_at) {
    pills.push(
      `<span class="pill">${ICON_CALENDAR}${escapeHtml(fullDateLabel(transcript.started_at, now))}</span>`,
    );
  }
  const namedParticipants = transcript.participants
    .map((p) => p.name)
    .filter(Boolean) as string[];
  if (namedParticipants.length) {
    const label =
      namedParticipants.length <= 2
        ? namedParticipants.join(", ")
        : `${namedParticipants.slice(0, 2).join(", ")} & ${namedParticipants.length - 2} others`;
    pills.push(`<span class="pill">${ICON_USERS}${escapeHtml(label)}</span>`);
  }

  const summaryBody = transcript.summary
    ? renderMarkdownLite(transcript.summary)
    : `<div class="empty-view">No summary saved for this transcript.</div>`;
  const transcriptBody = transcript.content
    ? renderTranscriptText(transcript.content)
    : `<div class="empty-view">No transcript text saved for this transcript.</div>`;

  const body = `
    <div class="transcript-detail">
      <a class="back-button" href="${escapeHtml(backHref)}" aria-label="Back">
        <svg class="field-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M10 3l-5 5 5 5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        ${ICON_PEOPLE}
      </a>
      <h1 class="transcript-title">${escapeHtml(display)}</h1>
      <div class="pill-row">${pills.join("")}</div>
      <div class="view-toggle" role="tablist">
        <button type="button" class="active" data-view="summary">${ICON_SUMMARY}<span>Summary</span></button>
        <button type="button" data-view="transcript">${ICON_TRANSCRIPT}<span>Transcript</span></button>
      </div>
      <div class="prose" data-pane="summary">${summaryBody}</div>
      <div class="prose" data-pane="transcript" style="display:none">${transcriptBody}</div>
    </div>
    <script>
      (() => {
        const tabs = document.querySelectorAll('.view-toggle button');
        const panes = document.querySelectorAll('[data-pane]');
        tabs.forEach((btn) => btn.addEventListener('click', () => {
          const view = btn.dataset.view;
          tabs.forEach((b) => b.classList.toggle('active', b === btn));
          panes.forEach((p) => {
            p.style.display = p.dataset.pane === view ? '' : 'none';
          });
        }));
      })();
    </script>
  `;
  return renderShell({ workspace, active: "people", counts, body });
}

async function handleRequest(
  lix: Lix,
  workspaceLabel: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  if (pathname === "/") {
    res.statusCode = 302;
    res.setHeader("Location", "/people");
    res.end();
    return;
  }

  const counts = await loadCounts(lix);

  if (pathname === "/people") {
    const [people, companies] = await Promise.all([
      loadPeople(lix),
      loadCompanies(lix),
    ]);
    const companyById = new Map(
      companies.filter((c) => c.name).map((c) => [c.id, c.name as string]),
    );
    const html = renderPeoplePage(people, companyById, workspaceLabel, counts);
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
    return;
  }

  const transcriptMatch = /^\/transcripts\/([^/]+)$/.exec(pathname);
  if (transcriptMatch) {
    const id = decodeURIComponent(transcriptMatch[1]!);
    const transcript = await loadTranscript(lix, id);
    if (!transcript) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Transcript not found");
      return;
    }
    const backRaw = url.searchParams.get("back");
    // Only allow same-site path-style hrefs to avoid open redirect.
    const backHref =
      backRaw && backRaw.startsWith("/") && !backRaw.startsWith("//")
        ? backRaw
        : "/people";
    const html = renderTranscriptPage({
      workspace: workspaceLabel,
      counts,
      transcript,
      backHref,
    });
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
    return;
  }

  const personMatch = /^\/people\/([^/]+)$/.exec(pathname);
  if (personMatch) {
    const id = decodeURIComponent(personMatch[1]!);
    const [people, companies, transcripts, posts] = await Promise.all([
      loadPeople(lix),
      loadCompanies(lix),
      loadTranscriptsForPerson(lix, id),
      loadPostsForPerson(lix, id),
    ]);
    const person = people.find((p) => p.id === id);
    if (!person) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Person not found");
      return;
    }
    const companyById = new Map(
      companies.filter((c) => c.name).map((c) => [c.id, c.name as string]),
    );
    const companyName = person.company_id
      ? (companyById.get(person.company_id) ?? null)
      : null;
    const html = renderPersonPage({
      workspace: workspaceLabel,
      counts,
      person,
      companyName,
      transcripts,
      posts,
    });
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
    return;
  }

  if (pathname === "/companies") {
    const [companies, people] = await Promise.all([
      loadCompanies(lix),
      loadPeople(lix),
    ]);
    const peopleByCompany = new Map<string, number>();
    for (const p of people) {
      if (!p.company_id) continue;
      peopleByCompany.set(p.company_id, (peopleByCompany.get(p.company_id) ?? 0) + 1);
    }
    const html = renderCompaniesPage(
      companies,
      peopleByCompany,
      workspaceLabel,
      counts,
    );
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
    return;
  }

  if (pathname === "/deals") {
    const [deals, companies] = await Promise.all([
      loadDeals(lix),
      loadCompanies(lix),
    ]);
    const companyById = new Map(
      companies.filter((c) => c.name).map((c) => [c.id, c.name as string]),
    );
    const html = renderDealsPage(deals, companyById, workspaceLabel, counts);
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
    return;
  }

  res.statusCode = 404;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("Not found");
}

function openInBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // fine — user can click the URL
  }
}

export function startUiServer(
  lix: Lix,
  workspaceLabel: string,
  opts: { port: number; open: boolean },
): void {
  const server = createServer((req, res) => {
    handleRequest(lix, workspaceLabel, req, res).catch((err) => {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(err instanceof Error ? err.message : String(err));
    });
  });

  server.on("error", (err) => {
    fail(err.message, ERR.UI);
    process.exit(1);
  });

  const url = `http://localhost:${opts.port}`;
  server.listen(opts.port, "127.0.0.1", () => {
    process.stdout.write(`acrm ui — ${workspaceLabel}\n`);
    process.stdout.write(`  ${url}\n`);
    process.stdout.write(`  Ctrl+C to stop\n`);
    if (opts.open) openInBrowser(url);
  });

  const shutdown = async () => {
    server.close();
    try {
      await lix.close();
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export function registerUi(program: Command): void {
  program
    .command("ui")
    .description(
      "launch a basic local browser UI to validate the .acrm file (read-only; tables for people, companies, deals)",
    )
    .option("-p, --port <port>", "port to listen on", "3737")
    .option("--no-open", "do not auto-open the browser")
    .addHelpText(
      "after",
      `
This UI is intentionally minimal — just enough to eyeball that an import landed
correctly. It is read-only, has no filters, search, or edit affordances.

Claude Code is expected to extend it as needed. The implementation is a single
file (src/commands/ui.ts): a node:http server with server-rendered HTML and
inline CSS, no client framework, no build step. To add a view, filter, or
detail drawer, edit that file directly.
`,
    )
    .action(async (opts: { port: string; open: boolean }) => {
      const root = program.opts() as { json?: boolean; workspace?: string };
      setJsonMode(root.json);
      const port = Number(opts.port);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        fail(`invalid port: ${opts.port}`, ERR.INVALID_INPUT);
        process.exit(1);
      }

      let lix: Lix;
      try {
        lix = await openWorkspace({ workspace: root.workspace });
      } catch (e) {
        if (e instanceof AcrmError) fail(e.message, e.code, e.hint);
        else fail(e instanceof Error ? e.message : String(e), ERR.UI);
        process.exit(1);
      }

      const resolved = root.workspace
        ? root.workspace.endsWith(".acrm")
          ? root.workspace
          : root.workspace + ".acrm"
        : (findWorkspace() ?? "workspace.acrm");
      const workspaceLabel = path.basename(resolved);

      startUiServer(lix, workspaceLabel, { port, open: opts.open });
    });
}

