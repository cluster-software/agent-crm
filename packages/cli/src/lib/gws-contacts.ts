import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { AcrmError, ERR, type GoogleContact } from "@agent-crm/sdk";

// Field masks the People API accepts. `urls` carries LinkedIn/X links on
// well-tended contact cards; `organizations` gives us current employer +
// job title.
const CONNECTIONS_PERSON_FIELDS =
  "names,emailAddresses,phoneNumbers,organizations,urls";
// otherContacts is read-only and limited to these three by Google.
const OTHER_READ_MASK = "names,emailAddresses,phoneNumbers";

export type GwsInstalledCheck =
  | { ok: true; version: string }
  | { ok: false; detail: string };

// Is the gws binary on PATH and runnable? Cheap — does not call any APIs.
export async function checkGwsInstalled(): Promise<GwsInstalledCheck> {
  const ver = await runCapture("gws", ["--version"]);
  if (ver.code === "ENOENT") return { ok: false, detail: "gws not on PATH" };
  if (ver.exit !== 0) {
    return {
      ok: false,
      detail: ver.stderr || ver.stdout || "gws exited non-zero",
    };
  }
  return { ok: true, version: ver.stdout.trim() };
}

// Is the user authenticated against the People API? Spends one cheap API
// call. Requires client_secret.json to already exist — call this AFTER
// ensureBundledClientSecret().
export async function checkGwsAuthed(): Promise<{
  ok: boolean;
  detail: string;
}> {
  const me = await runCapture("gws", [
    "people",
    "people",
    "get",
    "--params",
    JSON.stringify({ resourceName: "people/me", personFields: "names" }),
  ]);
  if (me.exit === 0) return { ok: true, detail: "" };
  return {
    ok: false,
    detail: me.stderr.trim() || me.stdout.trim() || "auth probe failed",
  };
}

export type GwsStreamOpts = {
  includeOtherContacts: boolean;
  // Optional override for testing.
  spawnOverride?: typeof spawn;
};

// Yield every contact across `people.connections` and (optionally)
// `otherContacts`, one at a time. The CLI consumer pipes this straight into
// importGoogleContacts so memory stays bounded — we never hold the full
// address book in a single array.
export async function* streamGoogleContacts(
  opts: GwsStreamOpts,
): AsyncIterable<GoogleContact> {
  yield* streamFrom("connections", opts);
  if (opts.includeOtherContacts) {
    yield* streamFrom("other_contacts", opts);
  }
}

async function* streamFrom(
  origin: "connections" | "other_contacts",
  opts: GwsStreamOpts,
): AsyncIterable<GoogleContact> {
  const args =
    origin === "connections"
      ? [
          "people",
          "people",
          "connections",
          "list",
          "--params",
          JSON.stringify({
            resourceName: "people/me",
            personFields: CONNECTIONS_PERSON_FIELDS,
            pageSize: 1000,
          }),
          "--page-all",
        ]
      : [
          "people",
          "otherContacts",
          "list",
          "--params",
          JSON.stringify({
            readMask: OTHER_READ_MASK,
            pageSize: 1000,
          }),
          "--page-all",
        ];

  const spawner = opts.spawnOverride ?? spawn;
  const child = spawner("gws", args, { stdio: ["ignore", "pipe", "pipe"] });
  const stderrChunks: Buffer[] = [];
  child.stderr?.on("data", (b: Buffer) => stderrChunks.push(b));

  const exitPromise: Promise<number> = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 0));
  });

  if (!child.stdout) {
    throw new AcrmError("gws produced no stdout stream", ERR.IMPORT);
  }
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let page: unknown;
    try {
      page = JSON.parse(trimmed);
    } catch {
      // gws emits well-formed NDJSON; non-JSON would be a real error.
      continue;
    }
    yield* extractContacts(page, origin);
  }
  const exit = await exitPromise;
  if (exit !== 0) {
    const detail = Buffer.concat(stderrChunks).toString("utf8").trim();
    throw new AcrmError(
      `gws ${origin === "connections" ? "people.connections.list" : "people.otherContacts.list"} failed (exit ${exit})`,
      ERR.IMPORT,
      detail || undefined,
    );
  }
}

function* extractContacts(
  page: unknown,
  origin: "connections" | "other_contacts",
): Iterable<GoogleContact> {
  if (!page || typeof page !== "object") return;
  const obj = page as Record<string, unknown>;
  const key = origin === "connections" ? "connections" : "otherContacts";
  const arr = obj[key];
  if (!Array.isArray(arr)) return;
  for (const raw of arr) {
    const c = normalizePerson(raw, origin);
    if (c) yield c;
  }
}

function normalizePerson(
  raw: unknown,
  origin: "connections" | "other_contacts",
): GoogleContact | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const resource_name = typeof p.resourceName === "string" ? p.resourceName : "";
  if (!resource_name) return null;

  const display_name = pickName(p.names);
  const emails = pickStrings(p.emailAddresses, "value", true /* primaryFirst */);
  const phones = pickStrings(p.phoneNumbers, "value", true);
  const urls = pickStrings(p.urls, "value", false);
  const organizations = pickOrganizations(p.organizations);

  return {
    resource_name,
    origin,
    display_name,
    emails,
    phones,
    urls,
    organizations,
  };
}

function pickName(field: unknown): string | null {
  if (!Array.isArray(field) || field.length === 0) return null;
  // Prefer the entry with metadata.primary === true; fall back to the first.
  let chosen: Record<string, unknown> | undefined;
  for (const n of field) {
    if (n && typeof n === "object") {
      const meta = (n as Record<string, unknown>).metadata as
        | Record<string, unknown>
        | undefined;
      if (meta && meta.primary === true) {
        chosen = n as Record<string, unknown>;
        break;
      }
    }
  }
  if (!chosen && field[0] && typeof field[0] === "object") {
    chosen = field[0] as Record<string, unknown>;
  }
  if (!chosen) return null;
  const display =
    typeof chosen.displayName === "string" ? chosen.displayName : null;
  if (display) return display;
  const given = typeof chosen.givenName === "string" ? chosen.givenName : "";
  const family = typeof chosen.familyName === "string" ? chosen.familyName : "";
  const composed = [given, family].filter(Boolean).join(" ").trim();
  return composed || null;
}

function pickStrings(
  field: unknown,
  key: string,
  primaryFirst: boolean,
): string[] {
  if (!Array.isArray(field)) return [];
  const out: string[] = [];
  let primary: string | null = null;
  for (const entry of field) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const v = obj[key];
    if (typeof v !== "string") continue;
    const trimmed = v.trim();
    if (!trimmed) continue;
    const meta = obj.metadata as Record<string, unknown> | undefined;
    const isPrimary = primaryFirst && !!meta && meta.primary === true;
    if (isPrimary && primary === null) primary = trimmed;
    else out.push(trimmed);
  }
  return primary !== null ? [primary, ...out] : out;
}

function pickOrganizations(
  field: unknown,
): Array<{ name?: string | null; title?: string | null }> {
  if (!Array.isArray(field)) return [];
  // Sort: current employer first.
  const sorted = [...field].sort((a, b) => {
    const ac = !!(a as Record<string, unknown> | null)?.current;
    const bc = !!(b as Record<string, unknown> | null)?.current;
    if (ac === bc) return 0;
    return ac ? -1 : 1;
  });
  return sorted
    .filter((o) => o && typeof o === "object")
    .map((o) => {
      const obj = o as Record<string, unknown>;
      return {
        name: typeof obj.name === "string" ? obj.name : null,
        title: typeof obj.title === "string" ? obj.title : null,
      };
    });
}

type CaptureResult = {
  exit: number;
  stdout: string;
  stderr: string;
  code?: string;
};

function runCapture(cmd: string, args: string[]): Promise<CaptureResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.once("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      resolve({ exit: 1, stdout, stderr, code });
    });
    child.once("close", (exitCode) => {
      resolve({ exit: exitCode ?? 0, stdout, stderr });
    });
  });
}

// Exported for unit tests.
export const __test = { extractContacts, normalizePerson };
