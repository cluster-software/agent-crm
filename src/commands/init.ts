import type { Command } from "commander";
import type { Lix, LixRuntimeValue } from "@lix-js/sdk";
import { openWorkspace } from "../workspace/open.js";
import { registerAllSchemas } from "../workspace/schemas/index.js";
import { exec } from "../db/execute.js";
import { fail, ok, setJsonMode } from "../output/json.js";
import { generateUuid } from "../lib/ids.js";
import { AcrmError, ERR } from "../lib/errors.js";

type ObjectSeed = {
  object_slug: string;
  singular_name: string;
  plural_name: string;
};

type AttributeSeed = {
  object_slug: string;
  attribute_slug: string;
  title: string;
  attribute_type: string;
  is_multivalued: boolean;
  is_unique: boolean;
  config?: Record<string, unknown>;
};

const OBJECTS: ObjectSeed[] = [
  { object_slug: "people", singular_name: "Person", plural_name: "People" },
  { object_slug: "companies", singular_name: "Company", plural_name: "Companies" },
  { object_slug: "deals", singular_name: "Deal", plural_name: "Deals" },
];

const ATTRIBUTES: AttributeSeed[] = [
  // companies
  { object_slug: "companies", attribute_slug: "name", title: "Name", attribute_type: "text", is_multivalued: false, is_unique: false },
  { object_slug: "companies", attribute_slug: "domains", title: "Domains", attribute_type: "domain", is_multivalued: true, is_unique: true },
  { object_slug: "companies", attribute_slug: "description", title: "Description", attribute_type: "text", is_multivalued: false, is_unique: false },
  { object_slug: "companies", attribute_slug: "linkedin_url", title: "LinkedIn", attribute_type: "url", is_multivalued: false, is_unique: false },
  { object_slug: "companies", attribute_slug: "team", title: "Team", attribute_type: "record-reference", is_multivalued: true, is_unique: false, config: { target_object: "people", inverse: "company" } },
  { object_slug: "companies", attribute_slug: "associated_deals", title: "Associated deals", attribute_type: "record-reference", is_multivalued: true, is_unique: false, config: { target_object: "deals", inverse: "associated_company" } },

  // people
  { object_slug: "people", attribute_slug: "name", title: "Name", attribute_type: "personal-name", is_multivalued: false, is_unique: false },
  { object_slug: "people", attribute_slug: "email_addresses", title: "Email addresses", attribute_type: "email-address", is_multivalued: true, is_unique: true },
  { object_slug: "people", attribute_slug: "job_title", title: "Job title", attribute_type: "text", is_multivalued: false, is_unique: false },
  { object_slug: "people", attribute_slug: "linkedin_url", title: "LinkedIn", attribute_type: "url", is_multivalued: false, is_unique: false },
  { object_slug: "people", attribute_slug: "company", title: "Company", attribute_type: "record-reference", is_multivalued: false, is_unique: false, config: { target_object: "companies", inverse: "team" } },
  { object_slug: "people", attribute_slug: "associated_deals", title: "Associated deals", attribute_type: "record-reference", is_multivalued: true, is_unique: false, config: { target_object: "deals", inverse: "associated_people" } },

  // deals
  { object_slug: "deals", attribute_slug: "name", title: "Name", attribute_type: "text", is_multivalued: false, is_unique: false },
  { object_slug: "deals", attribute_slug: "stage", title: "Stage", attribute_type: "status", is_multivalued: false, is_unique: false, config: { options: [{ id: "lead", title: "Lead" }, { id: "in_progress", title: "In Progress" }, { id: "won", title: "Won 🎉" }, { id: "lost", title: "Lost" }] } },
  { object_slug: "deals", attribute_slug: "value", title: "Value", attribute_type: "currency", is_multivalued: false, is_unique: false, config: { currency_code: "USD" } },
  { object_slug: "deals", attribute_slug: "associated_company", title: "Associated company", attribute_type: "record-reference", is_multivalued: false, is_unique: false, config: { target_object: "companies", inverse: "associated_deals" } },
  { object_slug: "deals", attribute_slug: "associated_people", title: "Associated people", attribute_type: "record-reference", is_multivalued: true, is_unique: false, config: { target_object: "people", inverse: "associated_deals" } },
  { object_slug: "deals", attribute_slug: "close_date", title: "Close date", attribute_type: "date", is_multivalued: false, is_unique: false },
  { object_slug: "deals", attribute_slug: "next_step", title: "Next step", attribute_type: "text", is_multivalued: false, is_unique: false },
];

async function seedObjects(lix: Lix): Promise<void> {
  for (const o of OBJECTS) {
    const have = await exec(
      lix,
      "SELECT object_slug FROM acrm_object WHERE object_slug = $1",
      [o.object_slug],
    );
    if (have.rows.length) continue;
    await exec(
      lix,
      "INSERT INTO acrm_object (object_slug, singular_name, plural_name) VALUES ($1, $2, $3)",
      [o.object_slug, o.singular_name, o.plural_name],
    );
  }
}

async function seedAttributes(lix: Lix): Promise<void> {
  for (const a of ATTRIBUTES) {
    const have = await exec(
      lix,
      "SELECT attribute_slug FROM acrm_attribute WHERE object_slug = $1 AND attribute_slug = $2",
      [a.object_slug, a.attribute_slug],
    );
    if (have.rows.length) continue;
    const params: LixRuntimeValue[] = [
      a.object_slug,
      a.attribute_slug,
      a.title,
      a.attribute_type,
      a.is_multivalued,
      a.is_unique,
      a.config ? JSON.stringify(a.config) : null,
    ];
    await exec(
      lix,
      `INSERT INTO acrm_attribute
        (object_slug, attribute_slug, title, attribute_type, is_multivalued, is_unique, config_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      params,
    );
  }
}

export function registerInit(program: Command): void {
  program
    .command("init <name>")
    .description("create a new .acrm file in the current directory (e.g. `acrm init cluster.acrm`)")
    .action(async (name: string) => {
      const root = program.opts() as { json?: boolean };
      setJsonMode(root.json);
      try {
        const lix = await openWorkspace({ workspace: name, create: true });
        try {
          await registerAllSchemas(lix);
          await seedObjects(lix);
          await seedAttributes(lix);
          const workspaceId = await generateUuid(lix);
          ok({ initialized: true, workspace_id: workspaceId });
        } finally {
          await lix.close();
        }
      } catch (e) {
        if (e instanceof AcrmError) fail(e.message, e.code);
        else fail(e instanceof Error ? e.message : String(e), ERR.INIT);
        process.exit(1);
      }
    });
}
