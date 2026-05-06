import { readFileSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import type { Lix, LixRuntimeValue } from "@lix-js/sdk";
import { findWorkspace, openWorkspace } from "../workspace/open.js";
import { exec } from "../db/execute.js";
import { fail, isJson, ok, setJsonMode } from "../output/json.js";
import { startUiServer } from "./ui.js";
import { generateUuid } from "../lib/ids.js";
import { nowIso } from "../lib/time.js";
import { AcrmError, ERR } from "../lib/errors.js";
import {
  encode,
  normalizeUniqueKey,
  normalizeDomain,
  domainFromEmail,
  type AttributeType,
} from "../domain/values.js";

type CsvRow = Record<string, string>;

function parseCsv(text: string): CsvRow[] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      cur.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      cur.push(field);
      rows.push(cur);
      cur = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field.length || cur.length) {
    cur.push(field);
    rows.push(cur);
  }
  if (!rows.length) return [];
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const out: CsvRow[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    if (row.length === 1 && row[0] === "") continue;
    const obj: CsvRow = {};
    for (let c = 0; c < header.length; c++) {
      obj[header[c]!] = (row[c] ?? "").trim();
    }
    out.push(obj);
  }
  return out;
}

function pick(row: CsvRow, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (v && v.length) return v;
  }
  return null;
}

async function findRecordByUnique(
  lix: Lix,
  object_slug: string,
  attribute_slug: string,
  normalized_key: string,
): Promise<string | null> {
  const r = await exec(
    lix,
    `SELECT record_id FROM acrm_value
     WHERE object_slug = $1 AND attribute_slug = $2
       AND normalized_key = $3 AND active_until IS NULL
     LIMIT 1`,
    [object_slug, attribute_slug, normalized_key],
  );
  return (r.rows[0]?.record_id as string | undefined) ?? null;
}

async function insertRecord(
  lix: Lix,
  object_slug: string,
  record_id: string,
): Promise<void> {
  await exec(
    lix,
    "INSERT INTO acrm_record (object_slug, record_id) VALUES ($1, $2)",
    [object_slug, record_id],
  );
}

async function insertValue(
  lix: Lix,
  args: {
    object_slug: string;
    record_id: string;
    attribute_slug: string;
    attribute_type: AttributeType;
    value_json: Record<string, unknown>;
    source: string;
    provenance: Record<string, unknown>;
  },
): Promise<void> {
  const normalized = normalizeUniqueKey(args.attribute_type, args.value_json);
  const ref =
    args.attribute_type === "record-reference"
      ? {
          ref_object: (args.value_json.target_object as string) ?? null,
          ref_record_id: (args.value_json.target_record_id as string) ?? null,
        }
      : { ref_object: null, ref_record_id: null };
  const params: LixRuntimeValue[] = [
    await generateUuid(lix),
    args.object_slug,
    args.record_id,
    args.attribute_slug,
    JSON.stringify(args.value_json),
    args.attribute_type,
    nowIso(),
    normalized,
    ref.ref_object,
    ref.ref_record_id,
    args.source,
    JSON.stringify(args.provenance),
  ];
  await exec(
    lix,
    `INSERT INTO acrm_value
      (id, object_slug, record_id, attribute_slug, value_json, attribute_type,
       active_from, normalized_key, ref_object, ref_record_id, source, provenance_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    params,
  );
}

async function getAttribute(
  lix: Lix,
  object_slug: string,
  attribute_slug: string,
): Promise<{ attribute_type: AttributeType } | null> {
  const r = await exec(
    lix,
    "SELECT attribute_type FROM acrm_attribute WHERE object_slug = $1 AND attribute_slug = $2",
    [object_slug, attribute_slug],
  );
  const row = r.rows[0];
  if (!row) return null;
  return { attribute_type: row.attribute_type as AttributeType };
}

async function setSingleValue(
  lix: Lix,
  args: {
    object_slug: string;
    record_id: string;
    attribute_slug: string;
    attribute_type: AttributeType;
    value: unknown;
    source: string;
    provenance: Record<string, unknown>;
  },
): Promise<void> {
  const value_json = encode(args.attribute_type, args.value);
  // close any active values
  await exec(
    lix,
    `UPDATE acrm_value SET active_until = $1
     WHERE object_slug = $2 AND record_id = $3 AND attribute_slug = $4 AND active_until IS NULL`,
    [nowIso(), args.object_slug, args.record_id, args.attribute_slug],
  );
  await insertValue(lix, { ...args, value_json });
}

async function addMultiValue(
  lix: Lix,
  args: {
    object_slug: string;
    record_id: string;
    attribute_slug: string;
    attribute_type: AttributeType;
    value: unknown;
    source: string;
    provenance: Record<string, unknown>;
  },
): Promise<void> {
  const value_json = encode(args.attribute_type, args.value);
  const normalized = normalizeUniqueKey(args.attribute_type, value_json);
  if (normalized) {
    const exists = await exec(
      lix,
      `SELECT 1 FROM acrm_value
       WHERE object_slug = $1 AND record_id = $2 AND attribute_slug = $3
         AND normalized_key = $4 AND active_until IS NULL LIMIT 1`,
      [args.object_slug, args.record_id, args.attribute_slug, normalized],
    );
    if (exists.rows.length) return;
  }
  await insertValue(lix, { ...args, value_json });
}

type Stats = {
  rows: number;
  companies_created: number;
  people_created: number;
  deals_created: number;
};

async function importRow(
  lix: Lix,
  row: CsvRow,
  source: string,
  rowIndex: number,
  stats: Stats,
): Promise<void> {
  const provenance = { row: rowIndex };

  const email = pick(row, "email", "email_address", "email_addresses");
  const composed = [pick(row, "first_name"), pick(row, "last_name")]
    .filter(Boolean)
    .join(" ")
    .trim();
  const fullName =
    pick(row, "name", "full_name", "person_name") ?? (composed.length ? composed : null);
  const companyName = pick(row, "company", "company_name", "organization");
  const domainRaw = pick(row, "domain", "website", "company_domain");
  const jobTitle = pick(row, "job_title", "title", "role");
  const linkedin = pick(row, "linkedin_url", "linkedin");

  // company
  let companyId: string | null = null;
  let companyDomain: string | null = null;
  if (domainRaw) companyDomain = normalizeDomain(domainRaw);
  else if (email) companyDomain = domainFromEmail(email);

  if (companyDomain) {
    const existing = await findRecordByUnique(lix, "companies", "domains", companyDomain);
    if (existing) {
      companyId = existing;
    } else {
      companyId = await generateUuid(lix);
      await insertRecord(lix, "companies", companyId);
      await addMultiValue(lix, {
        object_slug: "companies",
        record_id: companyId,
        attribute_slug: "domains",
        attribute_type: "domain",
        value: companyDomain,
        source,
        provenance,
      });
      if (companyName) {
        await setSingleValue(lix, {
          object_slug: "companies",
          record_id: companyId,
          attribute_slug: "name",
          attribute_type: "text",
          value: companyName,
          source,
          provenance,
        });
      }
      stats.companies_created++;
    }
  }

  // person
  let personId: string | null = null;
  if (email) {
    const normalized = email.trim().toLowerCase();
    const existing = await findRecordByUnique(
      lix,
      "people",
      "email_addresses",
      normalized,
    );
    if (existing) {
      personId = existing;
    } else {
      personId = await generateUuid(lix);
      await insertRecord(lix, "people", personId);
      await addMultiValue(lix, {
        object_slug: "people",
        record_id: personId,
        attribute_slug: "email_addresses",
        attribute_type: "email-address",
        value: email,
        source,
        provenance,
      });
      if (fullName) {
        await setSingleValue(lix, {
          object_slug: "people",
          record_id: personId,
          attribute_slug: "name",
          attribute_type: "personal-name",
          value: fullName,
          source,
          provenance,
        });
      }
      if (jobTitle) {
        await setSingleValue(lix, {
          object_slug: "people",
          record_id: personId,
          attribute_slug: "job_title",
          attribute_type: "text",
          value: jobTitle,
          source,
          provenance,
        });
      }
      if (linkedin) {
        await setSingleValue(lix, {
          object_slug: "people",
          record_id: personId,
          attribute_slug: "linkedin_url",
          attribute_type: "url",
          value: linkedin,
          source,
          provenance,
        });
      }
      stats.people_created++;
    }

    if (companyId) {
      await setSingleValue(lix, {
        object_slug: "people",
        record_id: personId,
        attribute_slug: "company",
        attribute_type: "record-reference",
        value: { target_object: "companies", target_record_id: companyId },
        source,
        provenance,
      });
    }
  }

  // deal (optional)
  const dealName = pick(row, "deal_name", "deal");
  if (dealName) {
    const dealId = await generateUuid(lix);
    await insertRecord(lix, "deals", dealId);
    await setSingleValue(lix, {
      object_slug: "deals",
      record_id: dealId,
      attribute_slug: "name",
      attribute_type: "text",
      value: dealName,
      source,
      provenance,
    });
    const stage = pick(row, "deal_stage", "stage");
    if (stage) {
      const attr = await getAttribute(lix, "deals", "stage");
      if (attr) {
        await setSingleValue(lix, {
          object_slug: "deals",
          record_id: dealId,
          attribute_slug: "stage",
          attribute_type: attr.attribute_type,
          value: stage,
          source,
          provenance,
        });
      }
    }
    const dealValue = pick(row, "deal_value", "value");
    if (dealValue) {
      await setSingleValue(lix, {
        object_slug: "deals",
        record_id: dealId,
        attribute_slug: "value",
        attribute_type: "currency",
        value: dealValue,
        source,
        provenance,
      });
    }
    const closeDate = pick(row, "close_date", "deal_close_date");
    if (closeDate) {
      await setSingleValue(lix, {
        object_slug: "deals",
        record_id: dealId,
        attribute_slug: "close_date",
        attribute_type: "date",
        value: closeDate,
        source,
        provenance,
      });
    }
    const nextStep = pick(row, "next_step", "deal_next_step");
    if (nextStep) {
      await setSingleValue(lix, {
        object_slug: "deals",
        record_id: dealId,
        attribute_slug: "next_step",
        attribute_type: "text",
        value: nextStep,
        source,
        provenance,
      });
    }
    if (companyId) {
      await setSingleValue(lix, {
        object_slug: "deals",
        record_id: dealId,
        attribute_slug: "associated_company",
        attribute_type: "record-reference",
        value: { target_object: "companies", target_record_id: companyId },
        source,
        provenance,
      });
    }
    if (personId) {
      await addMultiValue(lix, {
        object_slug: "deals",
        record_id: dealId,
        attribute_slug: "associated_people",
        attribute_type: "record-reference",
        value: { target_object: "people", target_record_id: personId },
        source,
        provenance,
      });
    }
    stats.deals_created++;
  }
}

export function registerImport(program: Command): void {
  const importCmd = program
    .command("import")
    .description(
      "import data into the .acrm file (creates people + companies; deals only when the CSV has deal columns)",
    );

  importCmd
    .command("csv <path>")
    .description(
      "import a CSV. Creates one person per email and one company per domain. Creates a deal only when the CSV has a 'deal_name' or 'deal' column — leads alone do not become deals.",
    )
    .option("-p, --port <port>", "port for the UI server", "3737")
    .option("--no-ui", "do not launch the UI after import")
    .option("--no-open", "do not auto-open the browser when launching the UI")
    .addHelpText(
      "after",
      `
Recognized columns (header is trim+lowercase only — use snake_case, not "Company Name"):

  Person     email | email_address | email_addresses
             name | full_name | person_name   (or first_name + last_name)
             job_title | title | role
             linkedin_url | linkedin

  Company    company | company_name | organization
             domain | website | company_domain

  Deal       deal_name | deal                 (presence triggers deal creation)
             deal_stage | stage
             deal_value | value
             close_date | deal_close_date
             next_step | deal_next_step

Identity:
  - companies are deduplicated by normalized domain (or domain-from-email)
  - people are deduplicated by lowercased email
  - rows without an email skip person creation
  - rows without a domain or email skip company creation
`,
    )
    .action(
      async (
        csvPath: string,
        opts: { port: string; ui: boolean; open: boolean },
      ) => {
        const root = program.opts() as { json?: boolean; workspace?: string };
        setJsonMode(root.json);
        const port = Number(opts.port);
        if (opts.ui && (!Number.isInteger(port) || port <= 0 || port > 65535)) {
          fail(`invalid port: ${opts.port}`, ERR.IMPORT);
          process.exit(1);
        }
        let lix: Awaited<ReturnType<typeof openWorkspace>> | null = null;
        try {
          const abs = path.resolve(csvPath);
          const text = readFileSync(abs, "utf8");
          const rows = parseCsv(text);
          const source = `csv:${path.basename(abs)}`;
          lix = await openWorkspace({ workspace: root.workspace });
          const stats: Stats = {
            rows: rows.length,
            companies_created: 0,
            people_created: 0,
            deals_created: 0,
          };
          for (let i = 0; i < rows.length; i++) {
            await importRow(lix, rows[i]!, source, i + 1, stats);
          }
          ok(stats);
          if (opts.ui) {
            const resolved = root.workspace
              ? root.workspace.endsWith(".acrm")
                ? root.workspace
                : root.workspace + ".acrm"
              : (findWorkspace() ?? "workspace.acrm");
            const workspaceLabel = path.basename(resolved);
            startUiServer(lix, workspaceLabel, { port, open: opts.open });
            // server now owns the lix handle
            return;
          }
          await lix.close();
          if (!isJson()) {
            const bold = process.env.NO_COLOR ? "" : "\x1b[1m";
            const reset = process.env.NO_COLOR ? "" : "\x1b[0m";
            process.stdout.write(
              `\nNext: ${bold}acrm ui${reset} to validate the import in your browser\n`,
            );
          }
        } catch (e) {
          if (lix) {
            try {
              await lix.close();
            } catch {
              // ignore
            }
          }
          if (e instanceof AcrmError) fail(e.message, e.code, e.hint);
          else fail(e instanceof Error ? e.message : String(e), ERR.IMPORT);
          process.exit(1);
        }
      },
    );
}
