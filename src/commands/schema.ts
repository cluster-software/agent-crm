import type { Command } from "commander";
import type { Lix, LixRuntimeValue } from "@lix-js/sdk";
import { openWorkspace } from "../workspace/open.js";
import { exec } from "../db/execute.js";
import { fail, ok, setJsonMode } from "../output/json.js";
import { AcrmError, ERR } from "../lib/errors.js";
import type { AttributeType, StatusOption } from "../domain/values.js";

const ATTRIBUTE_TYPES: AttributeType[] = [
  "text",
  "personal-name",
  "email-address",
  "domain",
  "url",
  "number",
  "currency",
  "date",
  "timestamp",
  "select",
  "status",
  "record-reference",
];

const SLUG_RE = /^[a-z][a-z0-9_]*$/;

function parseSlug(input: string, label: string): string {
  const s = input.trim();
  if (!SLUG_RE.test(s)) {
    throw new AcrmError(
      `invalid ${label}: ${input} (expected lowercase, starts with a letter, underscores allowed)`,
      ERR.INVALID_INPUT,
    );
  }
  return s;
}

function titleCase(slug: string): string {
  return slug
    .split("_")
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join(" ");
}

// Cheap heuristic for the default `--singular` label: drop a trailing 's' or
// turn '…ies' into '…y'. Object slugs are conventionally plural
// (people, companies, deals); irregular forms (people → person) require the
// user to pass --singular explicitly.
function defaultSingular(plural: string): string {
  if (plural.endsWith("ies") && plural.length > 3) {
    return plural.slice(0, -3) + "y";
  }
  if (plural.endsWith("s") && plural.length > 1) {
    return plural.slice(0, -1);
  }
  return plural;
}

function parseAttributeRef(ref: string): { object: string; attribute: string } {
  const i = ref.indexOf(".");
  if (i <= 0 || i === ref.length - 1) {
    throw new AcrmError(
      `expected <object>.<attribute>, got: ${ref}`,
      ERR.INVALID_INPUT,
    );
  }
  return {
    object: parseSlug(ref.slice(0, i), "object slug"),
    attribute: parseSlug(ref.slice(i + 1), "attribute slug"),
  };
}

function parseAttributeType(input: string): AttributeType {
  const s = input.trim().toLowerCase();
  if ((ATTRIBUTE_TYPES as string[]).includes(s)) return s as AttributeType;
  throw new AcrmError(
    `invalid --type: ${input}. One of: ${ATTRIBUTE_TYPES.join(", ")}`,
    ERR.INVALID_INPUT,
  );
}

function parseOption(raw: string): StatusOption {
  const i = raw.indexOf(":");
  const id = (i < 0 ? raw : raw.slice(0, i)).trim();
  if (!id) {
    throw new AcrmError(
      `invalid option (empty id): ${raw}`,
      ERR.INVALID_INPUT,
    );
  }
  const title = i < 0 || !raw.slice(i + 1).trim() ? titleCase(id) : raw.slice(i + 1).trim();
  return { id, title };
}

async function loadAttribute(
  lix: Lix,
  object_slug: string,
  attribute_slug: string,
): Promise<{
  attribute_type: AttributeType;
  is_multivalued: boolean;
  is_unique: boolean;
  config: Record<string, unknown> | null;
} | null> {
  const r = await exec(
    lix,
    "SELECT attribute_type, is_multivalued, is_unique, config_json FROM acrm_attribute WHERE object_slug = $1 AND attribute_slug = $2",
    [object_slug, attribute_slug],
  );
  const row = r.rows[0];
  if (!row) return null;
  let config: Record<string, unknown> | null = null;
  const raw = row.config_json as string | null | undefined;
  if (raw) {
    try {
      config = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      config = null;
    }
  }
  return {
    attribute_type: row.attribute_type as AttributeType,
    is_multivalued: Boolean(row.is_multivalued),
    is_unique: Boolean(row.is_unique),
    config,
  };
}

async function assertObjectExists(lix: Lix, object_slug: string): Promise<void> {
  const r = await exec(
    lix,
    "SELECT object_slug FROM acrm_object WHERE object_slug = $1",
    [object_slug],
  );
  if (!r.rows.length) {
    throw new AcrmError(
      `unknown object: ${object_slug}. Run \`acrm execute "SELECT object_slug FROM acrm_object"\` to list, or \`acrm object create ${object_slug}\` to register it.`,
      ERR.NOT_FOUND,
    );
  }
}

export function registerSchema(program: Command): void {
  // `object create` and `attribute add` / `edit-options` are the canonical
  // CLI affordance for shaping the workspace's schema. Without these, agents
  // hit a wall when the five built-in objects don't fit their domain and
  // either coerce data into the wrong object (the deals-as-hiring-pipeline
  // anti-pattern) or hand-roll INSERTs into acrm_object/acrm_attribute that
  // the docs steer them away from.
  const object = program
    .command("object")
    .description(
      "register or list custom objects (alongside the built-in people / companies / deals / posts / transcripts).",
    );

  object
    .command("create <slug>")
    .description(
      "register a new object (e.g. `candidates`, `tasks`, `accounts`). After creation, add fields with `acrm attribute add <object>.<slug> --type <type>` and create records with `acrm records create <object> --field <slug>=<value>`.",
    )
    .option(
      "--singular <name>",
      "human-friendly singular label (default: derived from slug, e.g. `candidates` → `Candidate`)",
    )
    .option(
      "--plural <name>",
      "human-friendly plural label (default: derived from slug, e.g. `candidates` → `Candidates`)",
    )
    .addHelpText(
      "after",
      `
Slug rules: lowercase ASCII, starts with a letter, underscores allowed.

Examples:
  acrm object create candidates
  acrm object create candidates --singular Candidate --plural Candidates
  acrm object create job_applications

Next steps after creation:
  acrm attribute add candidates.name --type personal-name
  acrm attribute add candidates.stage --type status \\
      --option sourced --option screen --option onsite --option offer
  acrm attribute add candidates.applied_for --type record-reference \\
      --target-object deals
  acrm records create candidates --field name="Daria Volkov" --field stage=screen
`,
    )
    .action(
      async (
        slug: string,
        opts: { singular?: string; plural?: string },
      ) => {
        const root = program.opts() as { json?: boolean; workspace?: string };
        setJsonMode(root.json);
        try {
          const object_slug = parseSlug(slug, "object slug");
          const plural = opts.plural?.trim() || titleCase(object_slug);
          const singular = opts.singular?.trim() || defaultSingular(plural);
          const lix = await openWorkspace({ workspace: root.workspace });
          try {
            const exists = await exec(
              lix,
              "SELECT object_slug FROM acrm_object WHERE object_slug = $1",
              [object_slug],
            );
            if (exists.rows.length) {
              throw new AcrmError(
                `object already exists: ${object_slug}`,
                ERR.UNIQUE_VIOLATION,
              );
            }
            await exec(
              lix,
              "INSERT INTO acrm_object (object_slug, singular_name, plural_name) VALUES ($1, $2, $3)",
              [object_slug, singular, plural],
            );
            ok({
              created: true,
              object_slug,
              singular_name: singular,
              plural_name: plural,
            });
          } finally {
            await lix.close();
          }
        } catch (e) {
          if (e instanceof AcrmError) fail(e.message, e.code, e.hint);
          else fail(e instanceof Error ? e.message : String(e), ERR.UNHANDLED);
          process.exit(1);
        }
      },
    );

  const attribute = program
    .command("attribute")
    .description(
      "add or edit attributes (fields) on any object. Works on built-in objects (people/companies/deals/posts/transcripts) and on custom objects created via `acrm object create`.",
    );

  attribute
    .command("add <ref>")
    .description(
      "add a new attribute to an object. <ref> is `<object>.<attribute>` (e.g. `candidates.stage`, `people.years_experience`).",
    )
    .requiredOption(
      "--type <type>",
      `attribute type — one of: ${ATTRIBUTE_TYPES.join(", ")}`,
    )
    .option(
      "--title <title>",
      "human-friendly label (default: derived from attribute slug)",
    )
    .option("--multivalued", "allow multiple values per record (default: false)")
    .option(
      "--unique",
      "values are unique across records (used for identifiers like email_addresses) (default: false)",
    )
    .option(
      "--option <id[:title]>",
      "for --type status / --type select: add a selectable option. Repeat for multiple. `id` is the canonical value; `title` is the display label (default: titlecased id).",
      (val: string, prev: string[]) => [...(prev ?? []), val],
      [] as string[],
    )
    .option(
      "--target-object <slug>",
      "for --type record-reference: the object this attribute points at (e.g. `companies`)",
    )
    .option(
      "--inverse <attribute_slug>",
      "for --type record-reference: optional inverse attribute slug on the target object (used by the UI for back-references)",
    )
    .option(
      "--currency-code <code>",
      "for --type currency: default currency code (e.g. `USD`)",
      "USD",
    )
    .addHelpText(
      "after",
      `
Examples:
  # add a text field to people
  acrm attribute add people.years_experience --type number

  # add a status field with options (the canonical hiring-pipeline shape)
  acrm attribute add candidates.stage --type status \\
      --option sourced --option screen --option onsite --option offer

  # add a record-reference to another object
  acrm attribute add candidates.applied_for --type record-reference \\
      --target-object deals --inverse candidates

  # add a multivalued, unique identifier (e.g. extra email_addresses)
  acrm attribute add people.secondary_emails --type email-address \\
      --multivalued --unique

To edit status/select options after the fact, use \`acrm attribute edit-options\`.
`,
    )
    .action(
      async (
        ref: string,
        opts: {
          type: string;
          title?: string;
          multivalued?: boolean;
          unique?: boolean;
          option?: string[];
          targetObject?: string;
          inverse?: string;
          currencyCode?: string;
        },
      ) => {
        const root = program.opts() as { json?: boolean; workspace?: string };
        setJsonMode(root.json);
        try {
          const { object: object_slug, attribute: attribute_slug } =
            parseAttributeRef(ref);
          const attribute_type = parseAttributeType(opts.type);
          const title = opts.title?.trim() || titleCase(attribute_slug);
          const is_multivalued = Boolean(opts.multivalued);
          const is_unique = Boolean(opts.unique);
          const config = buildAttributeConfig({
            attribute_type,
            options: opts.option,
            target_object: opts.targetObject,
            inverse: opts.inverse,
            currency_code: opts.currencyCode,
          });

          const lix = await openWorkspace({ workspace: root.workspace });
          try {
            await assertObjectExists(lix, object_slug);
            if (config && config.target_object) {
              await assertObjectExists(lix, config.target_object as string);
            }
            const have = await exec(
              lix,
              "SELECT attribute_slug FROM acrm_attribute WHERE object_slug = $1 AND attribute_slug = $2",
              [object_slug, attribute_slug],
            );
            if (have.rows.length) {
              throw new AcrmError(
                `attribute already exists: ${object_slug}.${attribute_slug}`,
                ERR.UNIQUE_VIOLATION,
              );
            }
            const params: LixRuntimeValue[] = [
              object_slug,
              attribute_slug,
              title,
              attribute_type,
              is_multivalued,
              is_unique,
              config ? JSON.stringify(config) : null,
            ];
            await exec(
              lix,
              `INSERT INTO acrm_attribute
                (object_slug, attribute_slug, title, attribute_type, is_multivalued, is_unique, config_json)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              params,
            );
            ok({
              added: true,
              object_slug,
              attribute_slug,
              attribute_type,
              is_multivalued,
              is_unique,
              ...(config ? { config } : {}),
            });
          } finally {
            await lix.close();
          }
        } catch (e) {
          if (e instanceof AcrmError) fail(e.message, e.code, e.hint);
          else fail(e instanceof Error ? e.message : String(e), ERR.UNHANDLED);
          process.exit(1);
        }
      },
    );

  attribute
    .command("edit-options <ref> <action> <option>")
    .description(
      "add or remove an option from a status/select attribute. <action> is `add` or `remove`; <option> is `<id>[:<title>]`.",
    )
    .addHelpText(
      "after",
      `
Examples:
  # extend deals.stage with a custom recruiting-funnel value
  acrm attribute edit-options deals.stage add sourced
  acrm attribute edit-options deals.stage add screen:Screening

  # drop an option no longer in use
  acrm attribute edit-options deals.stage remove lost

The id is the canonical value stored in acrm_value.value_json.id. The title is
what the UI / agents see. If you omit the title on \`add\`, it's derived from
the id (e.g. \`in_progress\` → \`In Progress\`). Removing an option does NOT
rewrite existing values — historical rows continue to reference the old id.
`,
    )
    .action(async (ref: string, action: string, option: string) => {
      const root = program.opts() as { json?: boolean; workspace?: string };
      setJsonMode(root.json);
      try {
        const { object: object_slug, attribute: attribute_slug } =
          parseAttributeRef(ref);
        const verb = action.trim().toLowerCase();
        if (verb !== "add" && verb !== "remove") {
          throw new AcrmError(
            `invalid action: ${action} (expected add | remove)`,
            ERR.INVALID_INPUT,
          );
        }

        const lix = await openWorkspace({ workspace: root.workspace });
        try {
          const attr = await loadAttribute(lix, object_slug, attribute_slug);
          if (!attr) {
            throw new AcrmError(
              `attribute not found: ${object_slug}.${attribute_slug}`,
              ERR.NOT_FOUND,
            );
          }
          if (
            attr.attribute_type !== "status" &&
            attr.attribute_type !== "select"
          ) {
            throw new AcrmError(
              `edit-options is only valid for status/select attributes; ${object_slug}.${attribute_slug} is ${attr.attribute_type}`,
              ERR.INVALID_INPUT,
            );
          }

          const current = (attr.config?.options as StatusOption[] | undefined) ?? [];
          let next: StatusOption[];
          if (verb === "add") {
            const opt = parseOption(option);
            if (current.some((o) => o.id === opt.id)) {
              throw new AcrmError(
                `option already exists: ${opt.id}`,
                ERR.UNIQUE_VIOLATION,
              );
            }
            next = [...current, opt];
          } else {
            const id = option.trim();
            if (!current.some((o) => o.id === id)) {
              throw new AcrmError(
                `option not found: ${id} (current: ${current.map((o) => o.id).join(", ") || "<none>"})`,
                ERR.NOT_FOUND,
              );
            }
            next = current.filter((o) => o.id !== id);
          }

          const nextConfig: Record<string, unknown> = {
            ...(attr.config ?? {}),
            options: next,
          };
          await exec(
            lix,
            "UPDATE acrm_attribute SET config_json = $1 WHERE object_slug = $2 AND attribute_slug = $3",
            [JSON.stringify(nextConfig), object_slug, attribute_slug],
          );
          ok({
            updated: true,
            object_slug,
            attribute_slug,
            attribute_type: attr.attribute_type,
            options: next,
          });
        } finally {
          await lix.close();
        }
      } catch (e) {
        if (e instanceof AcrmError) fail(e.message, e.code, e.hint);
        else fail(e instanceof Error ? e.message : String(e), ERR.UNHANDLED);
        process.exit(1);
      }
    });
}

function buildAttributeConfig(args: {
  attribute_type: AttributeType;
  options?: string[];
  target_object?: string;
  inverse?: string;
  currency_code?: string;
}): Record<string, unknown> | null {
  const cfg: Record<string, unknown> = {};
  if (args.attribute_type === "status" || args.attribute_type === "select") {
    const opts = (args.options ?? []).map(parseOption);
    if (opts.length === 0) {
      throw new AcrmError(
        `--type ${args.attribute_type} requires at least one --option <id[:title]>`,
        ERR.INVALID_INPUT,
        "Example: --option sourced --option screen --option onsite --option offer",
      );
    }
    const seen = new Set<string>();
    for (const o of opts) {
      if (seen.has(o.id)) {
        throw new AcrmError(
          `duplicate option id: ${o.id}`,
          ERR.INVALID_INPUT,
        );
      }
      seen.add(o.id);
    }
    cfg.options = opts;
  } else if (args.options && args.options.length > 0) {
    throw new AcrmError(
      `--option is only valid for --type status / --type select (got --type ${args.attribute_type})`,
      ERR.INVALID_INPUT,
    );
  }

  if (args.attribute_type === "record-reference") {
    if (!args.target_object) {
      throw new AcrmError(
        "--type record-reference requires --target-object <slug>",
        ERR.INVALID_INPUT,
      );
    }
    cfg.target_object = parseSlug(args.target_object, "target object");
    if (args.inverse) cfg.inverse = parseSlug(args.inverse, "inverse slug");
  } else if (args.target_object || args.inverse) {
    throw new AcrmError(
      "--target-object / --inverse are only valid for --type record-reference",
      ERR.INVALID_INPUT,
    );
  }

  if (args.attribute_type === "currency") {
    cfg.currency_code = (args.currency_code ?? "USD").trim().toUpperCase();
  }

  return Object.keys(cfg).length ? cfg : null;
}
