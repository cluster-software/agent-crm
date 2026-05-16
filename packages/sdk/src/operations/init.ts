import type { Lix, LixRuntimeValue } from "@lix-js/sdk";
import { exec } from "../db/execute.js";
import { generateUuid } from "../lib/ids.js";
import { registerAllSchemas } from "../workspace/schemas/index.js";
import { Workspace } from "../workspace.js";

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
  { object_slug: "posts", singular_name: "Post", plural_name: "Posts" },
  { object_slug: "transcripts", singular_name: "Transcript", plural_name: "Transcripts" },
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
  { object_slug: "people", attribute_slug: "twitter_url", title: "Twitter / X", attribute_type: "url", is_multivalued: false, is_unique: false },
  { object_slug: "people", attribute_slug: "company", title: "Company", attribute_type: "record-reference", is_multivalued: false, is_unique: false, config: { target_object: "companies", inverse: "team" } },
  { object_slug: "people", attribute_slug: "associated_deals", title: "Associated deals", attribute_type: "record-reference", is_multivalued: true, is_unique: false, config: { target_object: "deals", inverse: "associated_people" } },
  { object_slug: "people", attribute_slug: "associated_posts", title: "Associated posts", attribute_type: "record-reference", is_multivalued: true, is_unique: false, config: { target_object: "posts", inverse: "author" } },
  { object_slug: "people", attribute_slug: "associated_transcripts", title: "Associated transcripts", attribute_type: "record-reference", is_multivalued: true, is_unique: false, config: { target_object: "transcripts", inverse: "participants" } },

  // deals
  { object_slug: "deals", attribute_slug: "name", title: "Name", attribute_type: "text", is_multivalued: false, is_unique: false },
  { object_slug: "deals", attribute_slug: "stage", title: "Stage", attribute_type: "status", is_multivalued: false, is_unique: false, config: { options: [{ id: "lead", title: "Lead" }, { id: "in_progress", title: "In Progress" }, { id: "won", title: "Won 🎉" }, { id: "lost", title: "Lost" }] } },
  { object_slug: "deals", attribute_slug: "value", title: "Value", attribute_type: "currency", is_multivalued: false, is_unique: false, config: { currency_code: "USD" } },
  { object_slug: "deals", attribute_slug: "associated_company", title: "Associated company", attribute_type: "record-reference", is_multivalued: false, is_unique: false, config: { target_object: "companies", inverse: "associated_deals" } },
  { object_slug: "deals", attribute_slug: "associated_people", title: "Associated people", attribute_type: "record-reference", is_multivalued: true, is_unique: false, config: { target_object: "people", inverse: "associated_deals" } },
  { object_slug: "deals", attribute_slug: "close_date", title: "Close date", attribute_type: "date", is_multivalued: false, is_unique: false },
  { object_slug: "deals", attribute_slug: "next_step", title: "Next step", attribute_type: "text", is_multivalued: false, is_unique: false },

  // posts
  { object_slug: "posts", attribute_slug: "url", title: "URL", attribute_type: "url", is_multivalued: false, is_unique: true },
  { object_slug: "posts", attribute_slug: "platform", title: "Platform", attribute_type: "status", is_multivalued: false, is_unique: false, config: { options: [{ id: "linkedin", title: "LinkedIn" }, { id: "x", title: "X" }] } },
  { object_slug: "posts", attribute_slug: "author", title: "Author", attribute_type: "record-reference", is_multivalued: false, is_unique: false, config: { target_object: "people", inverse: "associated_posts" } },
  { object_slug: "posts", attribute_slug: "posted_at", title: "Posted at", attribute_type: "date", is_multivalued: false, is_unique: false },
  { object_slug: "posts", attribute_slug: "content", title: "Content", attribute_type: "text", is_multivalued: false, is_unique: false },

  // transcripts
  { object_slug: "transcripts", attribute_slug: "title", title: "Title", attribute_type: "text", is_multivalued: false, is_unique: false },
  { object_slug: "transcripts", attribute_slug: "started_at", title: "Started at", attribute_type: "timestamp", is_multivalued: false, is_unique: false },
  { object_slug: "transcripts", attribute_slug: "ended_at", title: "Ended at", attribute_type: "timestamp", is_multivalued: false, is_unique: false },
  { object_slug: "transcripts", attribute_slug: "duration_seconds", title: "Duration (seconds)", attribute_type: "number", is_multivalued: false, is_unique: false },
  { object_slug: "transcripts", attribute_slug: "source", title: "Source", attribute_type: "status", is_multivalued: false, is_unique: false, config: { options: [{ id: "granola", title: "Granola" }, { id: "zoom", title: "Zoom" }, { id: "meet", title: "Google Meet" }, { id: "teams", title: "Microsoft Teams" }, { id: "manual", title: "Manual" }, { id: "other", title: "Other" }] } },
  { object_slug: "transcripts", attribute_slug: "source_id", title: "Source ID", attribute_type: "text", is_multivalued: false, is_unique: true },
  { object_slug: "transcripts", attribute_slug: "summary", title: "Summary", attribute_type: "text", is_multivalued: false, is_unique: false },
  { object_slug: "transcripts", attribute_slug: "content", title: "Content", attribute_type: "text", is_multivalued: false, is_unique: false },
  { object_slug: "transcripts", attribute_slug: "participants", title: "Participants", attribute_type: "record-reference", is_multivalued: true, is_unique: false, config: { target_object: "people", inverse: "associated_transcripts" } },
];

export async function seedObjects(lix: Lix): Promise<void> {
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

export async function seedAttributes(lix: Lix): Promise<void> {
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

export type CreateWorkspaceResult = {
  workspace: Workspace;
  workspaceId: string;
};

// Create a fresh .acrm file at `absolutePath`, register all built-in
// schemas, and seed the default objects + attributes. Throws if the file
// already exists. The caller owns the returned Workspace and must close it.
export async function createWorkspace(
  absolutePath: string,
): Promise<CreateWorkspaceResult> {
  const workspace = await Workspace.create(absolutePath);
  await registerAllSchemas(workspace.lix);
  await seedObjects(workspace.lix);
  await seedAttributes(workspace.lix);
  const workspaceId = await generateUuid(workspace.lix);
  return { workspace, workspaceId };
}
