import path from "node:path";
import type { Command } from "commander";
import type { Lix } from "@lix-js/sdk";
import { findWorkspace, openWorkspace } from "../workspace/open.js";
import { fail, ok, setJsonMode } from "../output/json.js";
import { generateUuid } from "../lib/ids.js";
import { AcrmError, ERR } from "../lib/errors.js";
import { loadDotenv } from "../lib/dotenv.js";
import { normalizeTwitterUrl } from "../domain/values.js";
import { exec } from "../db/execute.js";
import {
  findRecordByUnique,
  insertRecord,
  setSingleValue,
} from "../db/upsert.js";
import {
  loadFromCacheOrFetch,
  normalizeXInput,
  type XProfile,
} from "../integrations/apify-x.js";
import { mapProfile, type MappedXProfile } from "../integrations/x-mapping.js";

const SOURCE = "x-import";
const ENRICHABLE = ["job_title", "company"] as const;

type Opts = {
  refresh?: boolean;
  cache?: boolean;
};

export type XImportResult = {
  person_record_id: string;
  created: { person: boolean };
  cache_path: string | null;
  cache_hit: boolean;
  mapped: MappedXProfile;
  bio: string | null;
  needs_enrichment: {
    person_record_id: string;
    bio: string;
    missing: string[];
    instructions: string;
  } | null;
};

export function attachXSubcommand(parent: Command): void {
  parent
    .command("x <handle-or-url>")
    .description(
      "Import a person from an X/Twitter profile (`@handle`, `handle`, or `https://x.com/handle`). Use when the user shares an X **profile** (e.g. \"add @jack\", \"import this X profile\"). For an X **post/tweet** URL instead, use `acrm import post`. Fetches the profile via Apify, upserts the person (deduped by twitter_url normalized to x.com/<handle>). If the bio contains role/company info, returns a `needs_enrichment` payload — trigger the `enrich-x-bio` skill on it. Requires APIFY_API_TOKEN in .env.",
    )
    .option("--refresh", "bypass cache and re-fetch from Apify")
    .option("--no-cache", "do not write the response to cache")
    .action(async (handleOrUrl: string, opts: Opts) => {
      const root = parent.parent?.opts() as
        | { workspace?: string; json?: boolean }
        | undefined;
      setJsonMode(root?.json);
      try {
        const result = await runImportX(handleOrUrl, {
          workspace: root?.workspace,
          refresh: opts.refresh,
          noCache: opts.cache === false,
        });
        ok({
          ...result,
          cache_path: result.cache_path
            ? path.relative(process.cwd(), result.cache_path)
            : null,
        });
      } catch (e) {
        if (e instanceof AcrmError) fail(e.message, e.code, e.hint);
        else fail(e instanceof Error ? e.message : String(e), ERR.UNHANDLED);
        process.exit(1);
      }
    });
}

async function runImportX(
  handleOrUrl: string,
  opts: { workspace?: string; refresh?: boolean; noCache?: boolean },
): Promise<XImportResult> {
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
  const workspaceDir = path.dirname(workspaceFile);
  loadDotenv(workspaceDir);
  loadDotenv(process.cwd());

  const token = process.env.APIFY_API_TOKEN;
  if (!token) {
    const envFile = path.join(workspaceDir, ".env");
    throw new AcrmError(
      "APIFY_API_TOKEN is not set",
      ERR.INVALID_INPUT,
      `create a .env file at ${envFile} containing:\n  APIFY_API_TOKEN=<your-apify-token>\n(or export APIFY_API_TOKEN in your shell)`,
    );
  }

  const cacheDir = path.join(workspaceDir, ".cache", "x");

  const lix = await openWorkspace({ workspace: workspaceFile });
  try {
    return await importXProfile({
      lix,
      handleOrUrl,
      token,
      cacheDir,
      refresh: opts.refresh,
      noCache: opts.noCache,
    });
  } finally {
    await lix.close();
  }
}

export type ImportXProfileArgs = {
  lix: Lix;
  handleOrUrl: string;
  token: string;
  cacheDir: string;
  refresh?: boolean;
  noCache?: boolean;
};

export async function importXProfile(
  args: ImportXProfileArgs,
): Promise<XImportResult> {
  const { lix, handleOrUrl, token, cacheDir, refresh, noCache } = args;
  const { handle } = normalizeXInput(handleOrUrl);

  const { profile, cachePath, cacheHit } = await loadFromCacheOrFetch({
    cacheDir,
    handle,
    token,
    refresh,
    noCache,
  });

  const mapped = mapProfile(profile, handle);

  const provenance = {
    actor: "apidojo~twitter-user-scraper",
    handle: mapped.person.handle,
    fetched_at: new Date().toISOString(),
    cache_hit: cacheHit,
  };

  const twitterKey = normalizeTwitterUrl(mapped.person.twitter_url);
  if (!twitterKey) {
    throw new AcrmError(
      "could not derive a normalized X URL from the profile",
      ERR.INVALID_INPUT,
    );
  }

  let personId = await findRecordByUnique(
    lix,
    "people",
    "twitter_url",
    twitterKey,
  );
  let personCreated = false;
  if (!personId) {
    personId = await generateUuid(lix);
    await insertRecord(lix, "people", personId);
    personCreated = true;
  }

  await setSingleValue(lix, {
    object_slug: "people",
    record_id: personId,
    attribute_slug: "twitter_url",
    attribute_type: "url",
    value: twitterKey,
    source: SOURCE,
    provenance,
  });

  if (mapped.person.name) {
    await setSingleValue(lix, {
      object_slug: "people",
      record_id: personId,
      attribute_slug: "name",
      attribute_type: "personal-name",
      value: mapped.person.name,
      source: SOURCE,
      provenance,
    });
  }

  const bio = pickBio(profile);
  const missing: string[] = [];
  for (const attr of ENRICHABLE) {
    if (!(await hasActiveValue(lix, "people", personId, attr))) {
      missing.push(attr);
    }
  }

  const needsEnrichment =
    bio && missing.length > 0
      ? {
          person_record_id: personId,
          bio,
          missing,
          instructions:
            "Extract role/company from `bio`. For each slug in `missing`, write a value via `acrm execute` UPDATE/INSERT on acrm_value. Only write what's clearly stated; skip if uncertain. Source: 'x-bio-enrichment'.",
        }
      : null;

  return {
    person_record_id: personId,
    created: { person: personCreated },
    cache_path: cachePath,
    cache_hit: cacheHit,
    mapped,
    bio,
    needs_enrichment: needsEnrichment,
  };
}

function pickBio(profile: XProfile): string | null {
  let raw: string | null = null;
  for (const k of ["description", "bio", "about"]) {
    const v = (profile as Record<string, unknown>)[k];
    if (typeof v === "string" && v.trim().length) {
      raw = v.trim();
      break;
    }
  }
  if (!raw) return null;
  return expandTcoUrls(raw, profile);
}

function expandTcoUrls(bio: string, profile: XProfile): string {
  const entities = (profile as Record<string, unknown>).entities as
    | { description?: { urls?: Array<Record<string, unknown>> } }
    | undefined;
  const urls = entities?.description?.urls;
  if (!Array.isArray(urls) || urls.length === 0) return bio;
  let out = bio;
  for (const u of urls) {
    const tco = typeof u.url === "string" ? u.url : null;
    const display =
      typeof u.display_url === "string"
        ? u.display_url
        : typeof u.expanded_url === "string"
          ? u.expanded_url.replace(/^https?:\/\//i, "")
          : null;
    if (tco && display) out = out.split(tco).join(display);
  }
  return out;
}

async function hasActiveValue(
  lix: Lix,
  object_slug: string,
  record_id: string,
  attribute_slug: string,
): Promise<boolean> {
  const r = await exec(
    lix,
    `SELECT 1 FROM acrm_value
     WHERE object_slug = $1 AND record_id = $2 AND attribute_slug = $3
       AND active_until IS NULL LIMIT 1`,
    [object_slug, record_id, attribute_slug],
  );
  return r.rows.length > 0;
}
