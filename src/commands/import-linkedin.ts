import path from "node:path";
import type { Command } from "commander";
import { findWorkspace, openWorkspace } from "../workspace/open.js";
import { fail, ok, setJsonMode } from "../output/json.js";
import { generateUuid } from "../lib/ids.js";
import { AcrmError, ERR } from "../lib/errors.js";
import { loadDotenv } from "../lib/dotenv.js";
import { normalizeLinkedinUrl } from "../domain/values.js";
import {
  findRecordByUnique,
  findCompanyByName,
  insertRecord,
  setSingleValue,
} from "../db/upsert.js";
import {
  loadFromCacheOrFetch,
  normalizeLinkedinInput,
} from "../integrations/apify-linkedin.js";
import { mapProfile } from "../integrations/linkedin-mapping.js";

const SOURCE = "linkedin-import";

type Opts = {
  refresh?: boolean;
  cache?: boolean; // commander negation: --no-cache → cache=false
};

export function attachLinkedinSubcommand(parent: Command): void {
  parent
    .command("linkedin <url-or-slug>")
    .description(
      "Fetch a LinkedIn profile via Apify and upsert person + company in the workspace",
    )
    .option("--refresh", "bypass cache and re-fetch from Apify")
    .option("--no-cache", "do not write the response to cache")
    .action(async (urlOrSlug: string, opts: Opts) => {
      const root = parent.parent?.opts() as
        | { workspace?: string; json?: boolean }
        | undefined;
      setJsonMode(root?.json);
      try {
        const result = await runImportLinkedin(urlOrSlug, {
          workspace: root?.workspace,
          refresh: opts.refresh,
          noCache: opts.cache === false,
        });
        ok(result);
      } catch (e) {
        if (e instanceof AcrmError) fail(e.message, e.code, e.hint);
        else fail(e instanceof Error ? e.message : String(e), ERR.UNHANDLED);
        process.exit(1);
      }
    });
}

async function runImportLinkedin(
  urlOrSlug: string,
  opts: { workspace?: string; refresh?: boolean; noCache?: boolean },
) {
  const { url, publicId } = normalizeLinkedinInput(urlOrSlug);

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

  const cacheDir = path.join(workspaceDir, ".cache", "linkedin");

  const { profile, cachePath, cacheHit } = await loadFromCacheOrFetch({
    cacheDir,
    publicId,
    url,
    token,
    refresh: opts.refresh,
    noCache: opts.noCache,
  });

  const mapped = mapProfile(profile);

  const lix = await openWorkspace({ workspace: workspaceFile });
  try {
    const provenance = {
      actor: "harvestapi~linkedin-profile-scraper",
      public_id: publicId,
      fetched_at: new Date().toISOString(),
      cache_hit: cacheHit,
    };

    // Company first so the person can reference it.
    let companyId: string | null = null;
    let companyCreated = false;
    if (mapped.company.name) {
      companyId = await findCompanyByName(lix, mapped.company.name);
      if (!companyId) {
        companyId = await generateUuid(lix);
        await insertRecord(lix, "companies", companyId);
        await setSingleValue(lix, {
          object_slug: "companies",
          record_id: companyId,
          attribute_slug: "name",
          attribute_type: "text",
          value: mapped.company.name,
          source: SOURCE,
          provenance,
        });
        companyCreated = true;
      }
      if (mapped.company.linkedin_url) {
        const cl = normalizeLinkedinUrl(mapped.company.linkedin_url);
        if (cl) {
          await setSingleValue(lix, {
            object_slug: "companies",
            record_id: companyId,
            attribute_slug: "linkedin_url",
            attribute_type: "url",
            value: cl,
            source: SOURCE,
            provenance,
          });
        }
      }
    }

    // Person — dedupe by LinkedIn URL.
    const linkedinKey = mapped.person.linkedin_url
      ? normalizeLinkedinUrl(mapped.person.linkedin_url)
      : normalizeLinkedinUrl(url);
    if (!linkedinKey) {
      throw new AcrmError(
        "could not derive a normalized LinkedIn URL from the profile",
        ERR.INVALID_INPUT,
      );
    }

    let personId = await findRecordByUnique(
      lix,
      "people",
      "linkedin_url",
      linkedinKey,
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
      attribute_slug: "linkedin_url",
      attribute_type: "url",
      value: linkedinKey,
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

    if (mapped.person.job_title) {
      await setSingleValue(lix, {
        object_slug: "people",
        record_id: personId,
        attribute_slug: "job_title",
        attribute_type: "text",
        value: mapped.person.job_title,
        source: SOURCE,
        provenance,
      });
    }

    if (companyId) {
      await setSingleValue(lix, {
        object_slug: "people",
        record_id: personId,
        attribute_slug: "company",
        attribute_type: "record-reference",
        value: { target_object: "companies", target_record_id: companyId },
        source: SOURCE,
        provenance,
      });
    }

    return {
      person_record_id: personId,
      company_record_id: companyId,
      created: { person: personCreated, company: companyCreated },
      cache_path: cachePath
        ? path.relative(process.cwd(), cachePath)
        : null,
      cache_hit: cacheHit,
      mapped,
    };
  } finally {
    await lix.close();
  }
}
