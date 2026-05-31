import { createInterface } from "node:readline";
import type { Command } from "commander";
import {
  AcrmError,
  ERR,
  applyDedupe,
  createRecord,
  dedupeRecords,
  planDedupe,
  updateRecord,
  type ConflictResolver,
  type DedupePolicy,
} from "@agent-crm/sdk";
import { openResolvedWorkspace, resolveWorkspacePath } from "../workspace-resolve.js";
import { fail, isJson, ok, setJsonMode } from "../output/json.js";

type Prefer = "keep" | "discard" | "interactive";

type DedupeOpts = {
  keep: string;
  discard: string;
  dryRun?: boolean;
  prefer?: string;
  json?: boolean;
};

function parsePrefer(input: string | undefined): Prefer {
  if (!input) return "keep";
  const s = input.trim().toLowerCase();
  if (s === "keep" || s === "discard" || s === "interactive") return s;
  throw new AcrmError(
    `invalid --prefer value: ${input} (expected keep | discard | interactive)`,
    ERR.INVALID_INPUT,
  );
}

function truncate(s: string, n = 80): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

// Readline-based conflict resolver for `--prefer interactive`. Each conflict
// prints the keeper + discard values to stderr and prompts on stdin.
function makeInteractiveResolver(): ConflictResolver {
  return async (info) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const keeperStr =
        typeof info.keeper_value_json === "string"
          ? info.keeper_value_json
          : JSON.stringify(info.keeper_value_json);
      const discardStr =
        typeof info.discard_value_json === "string"
          ? info.discard_value_json
          : JSON.stringify(info.discard_value_json);
      process.stderr.write(
        `\nconflict on ${info.attribute_slug}:\n` +
          `  keep    → ${truncate(keeperStr)}\n` +
          `  discard → ${truncate(discardStr)}\n`,
      );
      const answer = await new Promise<string>((resolve) =>
        rl.question("which to keep? [k=keep / d=discard] ", resolve),
      );
      const s = answer.trim().toLowerCase();
      return s.startsWith("d") ? "discard" : "keep";
    } finally {
      rl.close();
    }
  };
}

export function registerRecords(program: Command): void {
  // Namespace `records` carves out room for future per-record operations
  // (archive, restore, show, list) without crowding the top-level surface.
  // `dedupe` is the verb agents and humans reach for when two rows describe
  // the same entity — chosen over `merge` to keep clear of db's branch /
  // version merge terminology.
  const records = program
    .command("records")
    .description(
      "operations on records as a group (dedupe duplicates, etc.). Subcommands act on any object — `people`, `companies`, `deals`, `posts`, `transcripts`.",
    );

  records
    .command("create <object>")
    .description(
      "create a single record on <object> with one or more fields. Use this for ad-hoc creation against any object (built-in or custom) — for bulk loads use `acrm import csv`.",
    )
    .option(
      "--field <slug=value>",
      "set an attribute on the new record. Repeatable. For record-reference attributes, pass `<slug>=<target_object>:<target_record_id>`. For multivalued attributes, pass --field <slug>=<value> multiple times.",
      (val: string, prev: string[]) => [...(prev ?? []), val],
      [] as string[],
    )
    .addHelpText(
      "after",
      `
Examples:
  # create a deal linked to an existing person
  acrm records create deals \\
      --field name="Acme renewal" \\
      --field stage=in_progress \\
      --field value=50000 \\
      --field associated_people=people:<person_record_id>

  # create a record on a custom object (e.g. candidates registered via
  # \`acrm object create candidates\`)
  acrm records create candidates \\
      --field name="Daria Volkov" \\
      --field stage=screen \\
      --field email_addresses=daria@example.com

  # multivalued: repeat the same --field slug
  acrm records create candidates --field name="Liam" \\
      --field email_addresses=liam@home.com \\
      --field email_addresses=liam@work.com

Field syntax:
  <slug>=<value>
  <slug>=<target_object>:<target_record_id>   for record-reference attributes
  <slug>=                                     omit value to clear (no-op on create)

Status / select values must match a configured option id or title. To add a
new option to an enum, use \`acrm attribute edit-options\`.

Returns the new record_id, which you can pass to subsequent --field arguments
to wire up references.
`,
    )
    .action(async (object: string, opts: { field?: string[] }) => {
      const root = program.opts() as { json?: boolean; workspace?: string };
      setJsonMode(root.json);
      try {
        const ws = await openResolvedWorkspace(resolveWorkspacePath(root.workspace));
        try {
          const result = await createRecord(ws, {
            object_slug: object,
            fields: opts.field ?? [],
            source: "cli:records-create",
          });
          ok(result);
        } finally {
          await ws.close();
        }
      } catch (e) {
        if (e instanceof AcrmError) fail(e.message, e.code, e.hint);
        else fail(e instanceof Error ? e.message : String(e), ERR.UNHANDLED);
        process.exit(1);
      }
    });

  records
    .command("update <object> <record_id>")
    .description(
      "update fields on an existing record. For single-valued attributes (e.g. `stage`, `name`), replaces the current value. For multivalued attributes (e.g. `email_addresses`), adds a new value alongside existing ones — use `acrm records dedupe` to collapse duplicates.",
    )
    .option(
      "--field <slug=value>",
      "set an attribute. Repeatable. For record-reference attributes, pass `<slug>=<target_object>:<target_record_id>`. For multivalued attributes, repeat --field <slug> to add multiple values.",
      (val: string, prev: string[]) => [...(prev ?? []), val],
      [] as string[],
    )
    .addHelpText(
      "after",
      `
Examples:
  # advance a candidate through the pipeline
  acrm records update candidates <candidate_id> --field stage=screen
  acrm records update candidates <candidate_id> --field stage=onsite --field notes="great fit on async/io"

  # change a deal's value or close date
  acrm records update deals <deal_id> --field value=75000 --field close_date=2026-07-01

  # add another email to an existing person (multivalued)
  acrm records update people <person_id> --field email_addresses=alice@work.com

Field syntax (same as \`records create\`):
  <slug>=<value>
  <slug>=<target_object>:<target_record_id>   for record-reference attributes

Status / select values must match a configured option id or title — use
\`acrm attribute edit-options\` to extend an enum.

Validation runs before any write: bad enum values, unknown attributes, or a
missing record_id all fail loudly without touching the workspace.
`,
    )
    .action(
      async (
        object: string,
        record_id: string,
        opts: { field?: string[] },
      ) => {
        const root = program.opts() as { json?: boolean; workspace?: string };
        setJsonMode(root.json);
        try {
          const ws = await openResolvedWorkspace(resolveWorkspacePath(root.workspace));
          try {
            const result = await updateRecord(ws, {
              object_slug: object,
              record_id,
              fields: opts.field ?? [],
              source: "cli:records-update",
            });
            ok(result);
          } finally {
            await ws.close();
          }
        } catch (e) {
          if (e instanceof AcrmError) fail(e.message, e.code, e.hint);
          else fail(e instanceof Error ? e.message : String(e), ERR.UNHANDLED);
          process.exit(1);
        }
      },
    );

  records
    .command("dedupe <object>")
    .description(
      "collapse two duplicate records of the same object into one: reassign attribute values + inbound references from `--discard` to `--keep`, then delete the discarded record. Use when two `people`/`companies`/etc. records describe the same entity (e.g. one created from a LinkedIn import and a duplicate created from a transcript email).",
    )
    .requiredOption("--keep <record_id>", "the record to keep (winner)")
    .requiredOption("--discard <record_id>", "the record to delete (loser)")
    .option(
      "--prefer <policy>",
      "conflict policy for single-valued attributes: keep | discard | interactive (default: keep)",
      "keep",
    )
    .option(
      "--dry-run",
      "print the plan (rows moved, rows redirected, conflicts) without applying",
    )
    .addHelpText(
      "after",
      `
Examples:
  acrm records dedupe people --keep <luis-1> --discard <luis-2>
  acrm records dedupe people --keep <luis-1> --discard <luis-2> --dry-run
  acrm records dedupe people --keep <luis-1> --discard <luis-2> --prefer discard
  acrm records dedupe companies --keep <co-1> --discard <co-2>

What it does:
  1. Reassigns every \`acrm_value\` row from the discard to the keeper.
     - Multivalued attrs: dedupe by normalized_key (or ref_record_id for refs).
     - Single-valued attrs: keeper wins by default; \`--prefer discard\` flips it;
       \`--prefer interactive\` prompts on each conflict.
  2. Rewrites every inbound reference (acrm_value rows where
     ref_record_id = discard) to point at the keeper. Dedupes if the source
     record already had an active ref to the keeper.
  3. Deletes the discarded record from \`acrm_record\`.

Note: the final merge writes run in one workspace transaction. Use \`--dry-run\`
to inspect the validated plan before applying it.
`,
    )
    .action(async (object: string, opts: DedupeOpts) => {
      const root = program.opts() as { json?: boolean; workspace?: string };
      setJsonMode(root.json);
      try {
        const prefer = parsePrefer(opts.prefer);
        const ws = await openResolvedWorkspace(resolveWorkspacePath(root.workspace));
        try {
          let result;
          if (prefer === "interactive") {
            // Two-phase so the readline prompts run between plan and apply.
            const plan = await planDedupe(ws, {
              object_slug: object,
              keep_record_id: opts.keep,
              discard_record_id: opts.discard,
              resolveConflict: makeInteractiveResolver(),
            });
            if (opts.dryRun) {
              result = {
                ...plan,
                applied: false,
                values_moved: plan.items.filter(
                  (i) =>
                    i.kind === "move_multi" ||
                    i.kind === "move_single_empty_keeper",
                ).length,
                values_dropped: plan.items.filter(
                  (i) =>
                    i.kind === "drop_multi_duplicate" ||
                    i.kind === "single_conflict_keep_wins" ||
                    i.kind === "single_conflict_discard_wins",
                ).length,
                inbound_redirected: plan.items.filter(
                  (i) => i.kind === "inbound_redirect",
                ).length,
                inbound_dropped: plan.items.filter(
                  (i) => i.kind === "inbound_drop_duplicate",
                ).length,
                discard_record_deleted: false,
              };
            } else {
              result = await applyDedupe(ws, plan);
            }
          } else {
            result = await dedupeRecords(ws, {
              object_slug: object,
              keep_record_id: opts.keep,
              discard_record_id: opts.discard,
              prefer: prefer as DedupePolicy,
              dryRun: Boolean(opts.dryRun),
            });
          }
          ok(result);
          if (!isJson() && opts.dryRun) {
            process.stderr.write(`(dry-run — no changes applied)\n`);
          }
        } finally {
          await ws.close();
        }
      } catch (e) {
        if (e instanceof AcrmError) fail(e.message, e.code, e.hint);
        else fail(e instanceof Error ? e.message : String(e), ERR.UNHANDLED);
        process.exit(1);
      }
    });
}
