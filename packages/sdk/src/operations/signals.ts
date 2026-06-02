import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { exec } from "../db/execute.js";
import type { AttributeConfig, AttributeType } from "../domain/values.js";
import { AcrmError, ERR } from "../lib/errors.js";
import { nowIso } from "../lib/time.js";
import {
  addAttribute,
  type AddAttributeResult,
} from "./schema.js";
import { setSingleValue } from "../db/upsert.js";
import { loadAttribute } from "../workspace/catalog.js";
import { Workspace, workspaceDatabase } from "../workspace.js";

export type SignalObjectSlug = "people" | "companies";
export type SignalRunMode = "missing" | "force";

export type SignalOption = {
  id: string;
  title: string;
};

export type SignalOutputDefinition = {
  key: string;
  attribute: string;
  title: string;
  type: SignalAttributeType;
  options?: SignalOption[];
};

export type SignalDefinition = {
  slug: string;
  title: string;
  object_slug: SignalObjectSlug;
  outputs: SignalOutputDefinition[];
  prompt: string;
  definition_hash: string;
  path: string;
};

export type SignalRunnerContext = {
  signal: SignalDefinition;
  record: SignalRecordRef;
  requested_outputs: string[];
};

export type SignalRunner = (
  prompt: string,
  context: SignalRunnerContext,
) => Promise<string>;

export type SignalRecordRef = {
  object_slug: SignalObjectSlug;
  record_id: string;
};

export type SignalRunArgs = {
  signalsDir: string;
  signalSlugs?: string[];
  object_slug?: SignalObjectSlug;
  record_ids?: string[];
  records?: SignalRecordRef[];
  mode?: SignalRunMode;
  limit?: number;
  concurrency?: number;
  runner?: SignalRunner;
};

export type SignalRunFailure = SignalRecordRef & {
  signal_slug: string;
  message: string;
  num_turns?: number;
  estimated_num_turns?: number;
  stdout_excerpt?: string;
  stderr_excerpt?: string;
};

export type SignalRunStatus = SignalRecordRef & {
  signal_slug: string;
  status: "succeeded" | "failed" | "skipped";
  values_written?: number;
  num_turns?: number;
  estimated_num_turns?: number;
};

export type SignalRunResult = {
  definitions: number;
  records_considered: number;
  runs_attempted: number;
  runs_succeeded: number;
  runs_failed: number;
  values_written: number;
  skipped: number;
  failures: SignalRunFailure[];
  statuses: SignalRunStatus[];
};

export type SignalSyncResult = {
  definitions: number;
  attributes_created: number;
  attributes_updated: number;
  created: AddAttributeResult[];
  updated: Array<{
    object_slug: SignalObjectSlug;
    attribute_slug: string;
    options_added: string[];
    type_changed_from?: string;
    type_changed_to?: string;
    retired?: boolean;
  }>;
};

type SignalAttributeType = Extract<
  AttributeType,
  "text" | "number" | "url" | "date" | "timestamp" | "status" | "select"
>;

type Frontmatter = Record<string, string>;

type RecordContextValue = {
  attribute_slug: string;
  title: string;
  type: string;
  value: unknown;
};

type ParsedRunnerOutput = {
  key: string;
  value: unknown;
  confidence: string;
  citations: unknown[];
  reasoning: string;
  notes?: string;
};

const SIGNAL_OBJECTS = new Set<string>(["people", "companies"]);
const SUPPORTED_TYPES = new Set<string>([
  "text",
  "number",
  "url",
  "date",
  "timestamp",
  "status",
  "select",
]);
const SLUG_RE = /^[a-z][a-z0-9_]*$/;
const CORE_SIGNAL_BLOCKED_ATTRIBUTES: Record<SignalObjectSlug, Set<string>> = {
  companies: new Set([
    "name",
    "domains",
    "description",
    "linkedin_url",
    "team",
    "associated_deals",
  ]),
  people: new Set([
    "name",
    "email_addresses",
    "phone_numbers",
    "job_title",
    "linkedin_url",
    "twitter_url",
    "company",
    "associated_deals",
    "associated_posts",
    "associated_transcripts",
  ]),
};
const DEFAULT_RUNNER = [
  "claude",
  "-p",
  "--output-format",
  "stream-json",
  "--verbose",
  "--tools",
  "WebSearch,WebFetch,Bash",
  "--allowedTools",
  "WebSearch,WebFetch,Bash(agent-browser:*)",
];
const DEFAULT_SIGNAL_RUNS_MODEL = "sonnet";
const DEFAULT_RUNNER_TIMEOUT_MS = 5 * 60 * 1000;
const RUNNER_STDOUT_EXCERPT_CHARS = 4000;
const RUNNER_STDERR_EXCERPT_CHARS = 1200;

export async function loadSignalDefinitions(
  signalsDir: string,
): Promise<SignalDefinition[]> {
  const entries = await readdir(signalsDir, { withFileTypes: true }).catch((e) => {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  });
  const definitions: SignalDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = path.join(signalsDir, entry.name);
    const content = await readFile(filePath, "utf8");
    definitions.push(parseSignalDefinition(filePath, content));
  }
  return definitions.sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function ensureSignalAttributes(
  workspace: Workspace,
  definitions: SignalDefinition[],
): Promise<SignalSyncResult> {
  return await workspaceDatabase(workspace).transaction((db) =>
    ensureSignalAttributesInWorkspace(Workspace.fromDatabase(db), definitions)
  );
}

async function ensureSignalAttributesInWorkspace(
  workspace: Workspace,
  definitions: SignalDefinition[],
): Promise<SignalSyncResult> {
  const result: SignalSyncResult = {
    definitions: definitions.length,
    attributes_created: 0,
    attributes_updated: 0,
    created: [],
    updated: [],
  };

  for (const definition of definitions) {
    const retired = await retireRemovedSignalValues(workspace, definition);
    for (const attribute_slug of retired) {
      result.updated.push({
        object_slug: definition.object_slug,
        attribute_slug,
        options_added: [],
        retired: true,
      });
    }
    for (const output of definition.outputs) {
      assertOutputDoesNotTargetCoreField(definition, output);
      const existing = await loadAttribute(
        workspaceDatabase(workspace),
        definition.object_slug,
        output.attribute,
      );
      const config = configForOutput(output);
      if (!existing) {
        const created = await addAttribute(workspace, {
          object_slug: definition.object_slug,
          attribute_slug: output.attribute,
          attribute_type: output.type,
          title: output.title,
          is_multivalued: false,
          is_unique: false,
          config,
        });
        result.created.push(created);
        result.attributes_created++;
        continue;
      }

      if (existing.is_multivalued) {
        throw new AcrmError(
          `signal ${definition.slug} output ${output.key} targets multivalued attribute ${definition.object_slug}.${output.attribute}; signal outputs must be single-valued`,
          ERR.INVALID_INPUT,
        );
      }
      if (existing.attribute_type !== output.type) {
        await changeSignalAttributeType(workspace, definition, output, existing.attribute_type);
        result.updated.push({
          object_slug: definition.object_slug,
          attribute_slug: output.attribute,
          options_added: output.options?.map((option) => option.id) ?? [],
          type_changed_from: existing.attribute_type,
          type_changed_to: output.type,
        });
        result.attributes_updated++;
        continue;
      }

      const added = await ensureOptions(
        workspace,
        definition.object_slug,
        output,
        existing.config,
      );
      if (added.length > 0) {
        result.updated.push({
          object_slug: definition.object_slug,
          attribute_slug: output.attribute,
          options_added: added,
        });
        result.attributes_updated++;
      }
    }
  }

  return result;
}

function assertOutputDoesNotTargetCoreField(
  definition: SignalDefinition,
  output: SignalOutputDefinition,
): void {
  if (!CORE_SIGNAL_BLOCKED_ATTRIBUTES[definition.object_slug].has(output.attribute)) return;
  throw new AcrmError(
    `signal ${definition.slug} output ${output.key} targets core field ${definition.object_slug}.${output.attribute}; choose a dedicated signal attribute instead`,
    ERR.INVALID_INPUT,
  );
}

export async function runSignals(
  workspace: Workspace,
  args: SignalRunArgs,
): Promise<SignalRunResult> {
  const mode = args.mode ?? "missing";
  const definitions = filterDefinitions(
    await loadSignalDefinitions(args.signalsDir),
    args,
  );
  await ensureSignalAttributes(workspace, definitions);

  const records = await selectRecords(workspace, definitions, args);
  const result: SignalRunResult = {
    definitions: definitions.length,
    records_considered: records.length,
    runs_attempted: 0,
    runs_succeeded: 0,
    runs_failed: 0,
    values_written: 0,
    skipped: 0,
    failures: [],
    statuses: [],
  };

  const tasks: Array<() => Promise<void>> = [];
  for (const definition of definitions) {
    const matching = records.filter(
      (record) => record.object_slug === definition.object_slug,
    );
    for (const record of matching) {
      tasks.push(async () => {
        const active = await activeAttributesForOutputs(
          workspace,
          record,
          definition.outputs,
        );
        const requested = requestedOutputs(definition, active, mode);
        if (requested.length === 0) {
          result.skipped++;
          result.statuses.push({
            ...record,
            signal_slug: definition.slug,
            status: "skipped",
          });
          return;
        }
        result.runs_attempted++;
        try {
          const run = await runOneSignal(
            workspace,
            definition,
            record,
            requested,
            args.runner ?? defaultRunner,
          );
          result.values_written += run.values_written;
          result.runs_succeeded++;
          result.statuses.push({
            ...record,
            signal_slug: definition.slug,
            status: "succeeded",
            values_written: run.values_written,
            ...runnerTurnMetricFields(run),
          });
        } catch (e) {
          const failure = signalFailureFromError(e);
          result.runs_failed++;
          result.statuses.push({
            ...record,
            signal_slug: definition.slug,
            status: "failed",
            ...runnerTurnMetricFields(failure),
          });
          result.failures.push({
            ...record,
            signal_slug: definition.slug,
            message: failure.message,
            ...runnerTurnMetricFields(failure),
            ...(failure.stdout_excerpt ? { stdout_excerpt: failure.stdout_excerpt } : {}),
            ...(failure.stderr_excerpt ? { stderr_excerpt: failure.stderr_excerpt } : {}),
          });
        }
      });
      if (args.limit && tasks.length >= args.limit) break;
    }
    if (args.limit && tasks.length >= args.limit) break;
  }

  await runWithConcurrency(tasks, normalizePositiveInt(args.concurrency, 1));
  return result;
}

function parseSignalDefinition(
  filePath: string,
  content: string,
): SignalDefinition {
  const frontmatter = parseFrontmatter(content, filePath);
  const body = stripFrontmatter(content);
  const block = parseSignalBlock(body, filePath);
  const slug = requireSlug(frontmatter.slug, "slug", filePath);
  const title = requireString(frontmatter.title, "title", filePath);
  const object = requireSlug(frontmatter.object, "object", filePath);
  if (!SIGNAL_OBJECTS.has(object)) {
    throw new AcrmError(
      `invalid signal object in ${filePath}: ${object} (expected people or companies)`,
      ERR.INVALID_INPUT,
    );
  }
  const outputs = parseOutputs(block.outputs, filePath);
  const prompt = body.replace(block.raw, "").trim();
  if (!prompt) {
    throw new AcrmError(
      `signal ${slug} in ${filePath} is missing prompt instructions`,
      ERR.INVALID_INPUT,
    );
  }
  return {
    slug,
    title,
    object_slug: object as SignalObjectSlug,
    outputs,
    prompt,
    definition_hash: createHash("sha256").update(content).digest("hex"),
    path: filePath,
  };
}

function parseFrontmatter(content: string, filePath: string): Frontmatter {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    throw new AcrmError(
      `signal file ${filePath} is missing frontmatter`,
      ERR.INVALID_INPUT,
    );
  }
  const result: Frontmatter = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[kv[1]!] = value;
  }
  return result;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

function parseSignalBlock(
  body: string,
  filePath: string,
): { raw: string; outputs: unknown } {
  const match = body.match(/```json\s+acrm-signal\s*\r?\n([\s\S]*?)\r?\n```/);
  if (!match) {
    throw new AcrmError(
      `signal file ${filePath} is missing a \`\`\`json acrm-signal fenced block`,
      ERR.INVALID_INPUT,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]!);
  } catch (e) {
    throw new AcrmError(
      `invalid acrm-signal JSON in ${filePath}: ${e instanceof Error ? e.message : String(e)}`,
      ERR.INVALID_INPUT,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AcrmError(
      `invalid acrm-signal block in ${filePath}: expected object`,
      ERR.INVALID_INPUT,
    );
  }
  return {
    raw: match[0],
    outputs: (parsed as Record<string, unknown>).outputs,
  };
}

function parseOutputs(value: unknown, filePath: string): SignalOutputDefinition[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AcrmError(
      `signal file ${filePath} must declare at least one output`,
      ERR.INVALID_INPUT,
    );
  }
  const seenKeys = new Set<string>();
  const seenAttrs = new Set<string>();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new AcrmError(
        `invalid output #${index + 1} in ${filePath}: expected object`,
        ERR.INVALID_INPUT,
      );
    }
    const item = raw as Record<string, unknown>;
    const key = requireSlug(asString(item.key), "output.key", filePath);
    const attribute = requireSlug(
      asString(item.attribute),
      "output.attribute",
      filePath,
    );
    const title = requireString(asString(item.title), "output.title", filePath);
    const type = requireString(asString(item.type), "output.type", filePath);
    if (!SUPPORTED_TYPES.has(type)) {
      throw new AcrmError(
        `invalid output type in ${filePath}: ${type}`,
        ERR.INVALID_INPUT,
      );
    }
    if (seenKeys.has(key)) {
      throw new AcrmError(`duplicate output key in ${filePath}: ${key}`, ERR.INVALID_INPUT);
    }
    if (seenAttrs.has(attribute)) {
      throw new AcrmError(
        `duplicate output attribute in ${filePath}: ${attribute}`,
        ERR.INVALID_INPUT,
      );
    }
    seenKeys.add(key);
    seenAttrs.add(attribute);
    const output: SignalOutputDefinition = {
      key,
      attribute,
      title,
      type: type as SignalAttributeType,
    };
    const options = parseOptions(item.options, filePath, key, type);
    if (options) output.options = options;
    return output;
  });
}

function parseOptions(
  raw: unknown,
  filePath: string,
  key: string,
  type: string,
): SignalOption[] | undefined {
  if (type !== "status" && type !== "select") {
    if (raw !== undefined) {
      throw new AcrmError(
        `options are only valid for status/select output ${key} in ${filePath}`,
        ERR.INVALID_INPUT,
      );
    }
    return undefined;
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new AcrmError(
      `status/select output ${key} in ${filePath} requires options`,
      ERR.INVALID_INPUT,
    );
  }
  const seen = new Set<string>();
  return raw.map((option) => {
    let parsed: SignalOption;
    if (typeof option === "string") {
      const index = option.indexOf(":");
      const id = (index < 0 ? option : option.slice(0, index)).trim();
      const title = index < 0 ? titleCase(id) : option.slice(index + 1).trim();
      parsed = { id, title: title || titleCase(id) };
    } else if (option && typeof option === "object" && !Array.isArray(option)) {
      const item = option as Record<string, unknown>;
      parsed = {
        id: requireSlug(asString(item.id), "option.id", filePath),
        title: requireString(asString(item.title), "option.title", filePath),
      };
    } else {
      throw new AcrmError(
        `invalid option for output ${key} in ${filePath}`,
        ERR.INVALID_INPUT,
      );
    }
    if (!SLUG_RE.test(parsed.id)) {
      throw new AcrmError(
        `invalid option id for output ${key} in ${filePath}: ${parsed.id}`,
        ERR.INVALID_INPUT,
      );
    }
    if (seen.has(parsed.id)) {
      throw new AcrmError(
        `duplicate option id for output ${key} in ${filePath}: ${parsed.id}`,
        ERR.INVALID_INPUT,
      );
    }
    seen.add(parsed.id);
    return parsed;
  });
}

function requireSlug(value: string | undefined, label: string, filePath: string): string {
  const raw = requireString(value, label, filePath);
  if (!SLUG_RE.test(raw)) {
    throw new AcrmError(
      `invalid ${label} in ${filePath}: ${raw}`,
      ERR.INVALID_INPUT,
    );
  }
  return raw;
}

function requireString(
  value: string | undefined,
  label: string,
  filePath: string,
): string {
  if (!value || !value.trim()) {
    throw new AcrmError(`missing ${label} in ${filePath}`, ERR.INVALID_INPUT);
  }
  return value.trim();
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function titleCase(slug: string): string {
  return slug
    .split("_")
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

function configForOutput(output: SignalOutputDefinition): AttributeConfig | null {
  if (output.type !== "status" && output.type !== "select") return null;
  return { options: output.options ?? [] };
}

async function ensureOptions(
  workspace: Workspace,
  object_slug: SignalObjectSlug,
  output: SignalOutputDefinition,
  currentConfig: AttributeConfig | undefined,
): Promise<string[]> {
  if (output.type !== "status" && output.type !== "select") return [];
  const desired = output.options ?? [];
  const current = Array.isArray(currentConfig?.options)
    ? (currentConfig.options as SignalOption[])
    : [];
  const currentIds = new Set(current.map((option) => option.id));
  const missing = desired.filter((option) => !currentIds.has(option.id));
  if (missing.length === 0) return [];
  const nextConfig = {
    ...(currentConfig ?? {}),
    options: [...current, ...missing],
  };
  await exec(
    workspaceDatabase(workspace),
    "UPDATE acrm_attribute SET config_json = $1 WHERE object_slug = $2 AND attribute_slug = $3",
    [JSON.stringify(nextConfig), object_slug, output.attribute],
  );
  return missing.map((option) => option.id);
}

async function changeSignalAttributeType(
  workspace: Workspace,
  definition: SignalDefinition,
  output: SignalOutputDefinition,
  currentType: AttributeType,
): Promise<void> {
  const signalSource = `signal:${definition.slug}`;
  const active = await exec(
    workspaceDatabase(workspace),
    `SELECT source
       FROM acrm_value
      WHERE object_slug = $1
        AND attribute_slug = $2
        AND active_until IS NULL`,
    [definition.object_slug, output.attribute],
  );
  const hasUserValues = active.rows.some((row) => row.source !== signalSource);
  if (hasUserValues) {
    throw new AcrmError(
      `signal ${definition.slug} output ${output.key} wants ${definition.object_slug}.${output.attribute} to be ${output.type}, but it is ${currentType} and has non-signal values`,
      ERR.INVALID_INPUT,
    );
  }

  const now = nowIso();
  await exec(
    workspaceDatabase(workspace),
    `UPDATE acrm_value
        SET active_until = $1
      WHERE object_slug = $2
        AND attribute_slug = $3
        AND source = $4
        AND active_until IS NULL`,
    [now, definition.object_slug, output.attribute, signalSource],
  );
  await exec(
    workspaceDatabase(workspace),
    `UPDATE acrm_attribute
        SET title = $1,
            attribute_type = $2,
            config_json = $3
      WHERE object_slug = $4
        AND attribute_slug = $5`,
    [
      output.title,
      output.type,
      configForOutput(output) ? JSON.stringify(configForOutput(output)) : null,
      definition.object_slug,
      output.attribute,
    ],
  );
}

async function retireRemovedSignalValues(
  workspace: Workspace,
  definition: SignalDefinition,
): Promise<string[]> {
  const desired = new Set(definition.outputs.map((output) => output.attribute));
  const signalSource = `signal:${definition.slug}`;
  const active = await exec(
    workspaceDatabase(workspace),
    `SELECT DISTINCT attribute_slug
       FROM acrm_value
      WHERE object_slug = $1
        AND source = $2
        AND active_until IS NULL`,
    [definition.object_slug, signalSource],
  );
  const removed = active.rows
    .map((row) => String(row.attribute_slug))
    .filter((attribute_slug) => !desired.has(attribute_slug));
  if (removed.length === 0) return [];

  const placeholders = removed.map((_, index) => `$${index + 4}`).join(", ");
  await exec(
    workspaceDatabase(workspace),
    `UPDATE acrm_value
        SET active_until = $1
      WHERE object_slug = $2
        AND source = $3
        AND active_until IS NULL
        AND attribute_slug IN (${placeholders})`,
    [nowIso(), definition.object_slug, signalSource, ...removed],
  );
  return removed;
}

function filterDefinitions(
  definitions: SignalDefinition[],
  args: SignalRunArgs,
): SignalDefinition[] {
  const slugs = args.signalSlugs ? new Set(args.signalSlugs) : null;
  return definitions.filter((definition) => {
    if (slugs && !slugs.has(definition.slug)) return false;
    if (args.object_slug && definition.object_slug !== args.object_slug) return false;
    return true;
  });
}

async function selectRecords(
  workspace: Workspace,
  definitions: SignalDefinition[],
  args: SignalRunArgs,
): Promise<SignalRecordRef[]> {
  if (args.records) {
    return uniqueRecords(
      args.records.filter((record) => {
        if (args.object_slug && record.object_slug !== args.object_slug) return false;
        return SIGNAL_OBJECTS.has(record.object_slug);
      }),
    );
  }
  if (args.record_ids && args.record_ids.length > 0) {
    if (!args.object_slug) {
      throw new AcrmError(
        "object_slug is required when selecting signal records by record_id",
        ERR.INVALID_INPUT,
      );
    }
    return uniqueRecords(
      args.record_ids.map((record_id) => ({
        object_slug: args.object_slug!,
        record_id,
      })),
    );
  }

  const objects = new Set(definitions.map((definition) => definition.object_slug));
  const records: SignalRecordRef[] = [];
  for (const object_slug of objects) {
    const r = await exec(
      workspaceDatabase(workspace),
      "SELECT record_id FROM acrm_record WHERE object_slug = $1 ORDER BY record_id DESC",
      [object_slug],
    );
    for (const row of r.rows) {
      records.push({
        object_slug,
        record_id: String(row.record_id),
      });
    }
  }
  return records;
}

function uniqueRecords(records: SignalRecordRef[]): SignalRecordRef[] {
  const seen = new Set<string>();
  const out: SignalRecordRef[] = [];
  for (const record of records) {
    const key = `${record.object_slug}:${record.record_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(record);
  }
  return out;
}

async function activeAttributesForOutputs(
  workspace: Workspace,
  record: SignalRecordRef,
  outputs: SignalOutputDefinition[],
): Promise<Set<string>> {
  if (outputs.length === 0) return new Set();
  const placeholders = outputs.map((_, index) => `$${index + 3}`).join(", ");
  const r = await exec(
    workspaceDatabase(workspace),
    `SELECT attribute_slug
       FROM acrm_value
      WHERE object_slug = $1
        AND record_id = $2
        AND active_until IS NULL
        AND attribute_slug IN (${placeholders})
      ORDER BY active_from DESC`,
    [record.object_slug, record.record_id, ...outputs.map((output) => output.attribute)],
  );
  const active = new Set<string>();
  for (const row of r.rows) {
    const attr = String(row.attribute_slug);
    active.add(attr);
  }
  return active;
}

function requestedOutputs(
  definition: SignalDefinition,
  active: Set<string>,
  mode: SignalRunMode,
): SignalOutputDefinition[] {
  if (mode === "force") return definition.outputs;
  return definition.outputs.filter((output) => !active.has(output.attribute));
}

async function runOneSignal(
  workspace: Workspace,
  definition: SignalDefinition,
  record: SignalRecordRef,
  requested: SignalOutputDefinition[],
  runner: SignalRunner,
): Promise<{ values_written: number } & RunnerTurnMetrics> {
  const recordContext = await loadRecordContext(workspace, record);
  const prompt = buildRunnerPrompt(definition, record, requested, recordContext);
  const raw = await runner(prompt, {
    signal: definition,
    record,
    requested_outputs: requested.map((output) => output.key),
  });
  const metrics = runnerTurnMetrics(raw);
  let outputs: ParsedRunnerOutput[];
  try {
    outputs = parseRunnerResponse(raw, definition);
    validateRunnerOutputs(outputs, definition);
  } catch (e) {
    throw new SignalRunnerOutputError(e, raw);
  }
  const requestedKeys = new Set(requested.map((output) => output.key));
  const outputByKey = new Map(definition.outputs.map((output) => [output.key, output]));
  const ran_at = nowIso();
  let written = 0;

  await workspaceDatabase(workspace).transaction(async (db) => {
    for (const output of outputs) {
      if (!requestedKeys.has(output.key)) continue;
      const definitionOutput = outputByKey.get(output.key)!;
      await setSingleValue(db, {
        object_slug: definition.object_slug,
        record_id: record.record_id,
        attribute_slug: definitionOutput.attribute,
        attribute_type: definitionOutput.type,
        value: output.value,
        source: `signal:${definition.slug}`,
        provenance: {
          signal_slug: definition.slug,
          output_key: output.key,
          ran_at,
          definition_hash: definition.definition_hash,
          confidence: output.confidence,
          citations: output.citations,
          reasoning: output.reasoning,
          ...(output.notes ? { notes: output.notes } : {}),
          uncited: output.citations.length === 0,
        },
      });
      written++;
    }
  });
  return {
    values_written: written,
    ...runnerTurnMetricFields(metrics),
  };
}

async function loadRecordContext(
  workspace: Workspace,
  record: SignalRecordRef,
): Promise<RecordContextValue[]> {
  const r = await exec(
    workspaceDatabase(workspace),
    `SELECT v.attribute_slug, v.value_json, a.title, a.attribute_type
       FROM acrm_value v
       JOIN acrm_attribute a
         ON a.object_slug = v.object_slug
        AND a.attribute_slug = v.attribute_slug
      WHERE v.object_slug = $1
        AND v.record_id = $2
        AND v.active_until IS NULL
      ORDER BY v.attribute_slug, v.active_from DESC`,
    [record.object_slug, record.record_id],
  );
  return r.rows.map((row) => ({
    attribute_slug: String(row.attribute_slug),
    title: String(row.title ?? row.attribute_slug),
    type: String(row.attribute_type),
    value: parseJson(row.value_json),
  }));
}

function buildRunnerPrompt(
  definition: SignalDefinition,
  record: SignalRecordRef,
  requested: SignalOutputDefinition[],
  recordContext: RecordContextValue[],
): string {
  return `You are filling an Agent CRM local signal.

Signal:
${JSON.stringify(
  {
    slug: definition.slug,
    title: definition.title,
    object: definition.object_slug,
  },
  null,
  2,
)}

Record:
${JSON.stringify({ ...record, values: recordContext }, null, 2)}

Requested outputs:
${JSON.stringify(
  requested.map((output) => ({
    key: output.key,
    attribute: output.attribute,
    title: output.title,
    type: output.type,
    options: output.options,
  })),
  null,
  2,
)}

Value type rules:
${requested.map(outputTypeRule).join("\n")}

Instructions:
${definition.prompt}

Return ONLY one valid JSON object with this exact shape:
{
  "outputs": [
    {
      "key": "<one requested key>",
      "value": "<typed value>",
      "confidence": "low|medium|high",
      "citations": [{"url":"https://...", "title":"...", "quote":"short supporting quote"}],
      "reasoning": "Concise public rationale for why this value is supported.",
      "notes": "Optional extra context."
    }
  ]
}

Rules:
- Output must be raw JSON parseable by JSON.parse. No prose, markdown, code fences, comments, or trailing commas.
- Every returned output.key must exactly match one requested key.
- Every returned output.value must match that key's declared type rule above.
- confidence must be exactly one of: "low", "medium", "high".
- Use WebSearch to discover public sources and WebFetch to verify pages before citing them.
- Never cite training data, memory, inferred page contents, or a URL you did not fetch or otherwise verify in this run.
- Do not include hidden chain-of-thought; reasoning must be a concise auditable explanation.
- Return no output for a key when the evidence is too weak to choose a value.
- Citations may be empty only when no source is available; uncited values will be marked in CRM provenance.
- Do not invent records, companies, people, or outreach channels.`;
}

function outputTypeRule(output: SignalOutputDefinition): string {
  const prefix = `- ${output.key} (${output.type}):`;
  switch (output.type) {
    case "text":
      return `${prefix} value must be a non-empty JSON string.`;
    case "number":
      return `${prefix} value must be a finite JSON number, not a quoted string.`;
    case "url":
      return `${prefix} value must be a non-empty absolute http(s) URL string.`;
    case "date":
      return `${prefix} value must be a string in YYYY-MM-DD format.`;
    case "timestamp":
      return `${prefix} value must be an ISO-8601 timestamp string with timezone, e.g. 2026-05-20T14:30:00Z.`;
    case "status":
    case "select":
      return `${prefix} value must be one of these option ids as a JSON string: ${(output.options ?? []).map((option) => option.id).join(", ")}.`;
  }
}

function parseRunnerResponse(
  raw: string,
  definition: SignalDefinition,
): ParsedRunnerOutput[] {
  const parsed = parseRunnerPayload(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AcrmError(
      `signal ${definition.slug} returned invalid JSON object. Output excerpt: ${outputExcerpt(raw)}`,
      ERR.INVALID_INPUT,
    );
  }
  const outputs = (parsed as Record<string, unknown>).outputs;
  if (!Array.isArray(outputs)) {
    throw new AcrmError(
      `signal ${definition.slug} response missing outputs[]`,
      ERR.INVALID_INPUT,
    );
  }
  return outputs.map((rawOutput, index) => {
    if (!rawOutput || typeof rawOutput !== "object" || Array.isArray(rawOutput)) {
      throw new AcrmError(
        `signal ${definition.slug} output #${index + 1} is not an object`,
        ERR.INVALID_INPUT,
      );
    }
    const item = rawOutput as Record<string, unknown>;
    const key = typeof item.key === "string" ? item.key : "";
    const confidence = typeof item.confidence === "string" ? item.confidence.trim() : "";
    const reasoning = typeof item.reasoning === "string" ? item.reasoning.trim() : "";
    if (!key || !reasoning) {
      throw new AcrmError(
        `signal ${definition.slug} output #${index + 1} requires key and reasoning`,
        ERR.INVALID_INPUT,
      );
    }
    if (!isConfidence(confidence)) {
      throw new AcrmError(
        `signal ${definition.slug} output ${key} has invalid confidence: ${String(item.confidence)} (expected low, medium, or high)`,
        ERR.INVALID_INPUT,
      );
    }
    if (!("value" in item) || item.value === null || item.value === undefined || item.value === "") {
      throw new AcrmError(
        `signal ${definition.slug} output ${key} is missing value`,
        ERR.INVALID_INPUT,
      );
    }
    return {
      key,
      value: item.value,
      confidence,
      citations: normalizeCitations(item.citations),
      reasoning,
      ...(typeof item.notes === "string" && item.notes.trim()
        ? { notes: item.notes.trim() }
        : {}),
    };
  });
}

function parseRunnerPayload(raw: string): unknown {
  const streamResult = parseClaudeStreamResult(raw);
  if (streamResult !== undefined) return unwrapClaudeJson(streamResult);
  return unwrapClaudeJson(parseJson(extractJson(raw)));
}

type RunnerTurnMetrics = {
  num_turns?: number;
  estimated_num_turns?: number;
};

function parseClaudeStreamObjects(raw: string): Record<string, unknown>[] {
  return stripAnsi(raw)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return [parsed as Record<string, unknown>];
        }
        return [];
      } catch {
        return [];
      }
    });
}

function parseClaudeStreamResult(raw: string): unknown {
  const objects = parseClaudeStreamObjects(raw);
  if (objects.length < 2) return undefined;
  for (const item of objects.slice().reverse()) {
    if (item.type === "result") return item;
  }
  return undefined;
}

function runnerTurnMetrics(raw: string): RunnerTurnMetrics {
  const objects = parseClaudeStreamObjects(raw);
  let num_turns: number | undefined;
  let toolResultMessages = 0;
  for (const item of objects) {
    if (item.type === "result" && typeof item.num_turns === "number") {
      num_turns = item.num_turns;
    }
    if (item.type === "user") {
      const message = item.message;
      if (!message || typeof message !== "object" || Array.isArray(message)) continue;
      const content = (message as Record<string, unknown>).content;
      if (!Array.isArray(content)) continue;
      const hasToolResult = content.some((block) =>
        block &&
        typeof block === "object" &&
        !Array.isArray(block) &&
        (block as Record<string, unknown>).type === "tool_result",
      );
      if (hasToolResult) {
        toolResultMessages++;
      }
    }
  }
  const estimated_num_turns =
    num_turns === undefined && toolResultMessages > 0 ? toolResultMessages + 1 : undefined;
  return runnerTurnMetricFields({ num_turns, estimated_num_turns });
}

function runnerTurnMetricFields(metrics: RunnerTurnMetrics): RunnerTurnMetrics {
  return {
    ...(metrics.num_turns !== undefined ? { num_turns: metrics.num_turns } : {}),
    ...(metrics.estimated_num_turns !== undefined
      ? { estimated_num_turns: metrics.estimated_num_turns }
      : {}),
  };
}

function unwrapClaudeJson(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  const item = parsed as Record<string, unknown>;
  if (item.structured_output !== undefined) return item.structured_output;
  if (typeof item.result === "string") {
    return parseJson(extractJson(item.result));
  }
  return parsed;
}

function validateRunnerOutputs(
  outputs: ParsedRunnerOutput[],
  definition: SignalDefinition,
): void {
  const byKey = new Map(definition.outputs.map((output) => [output.key, output]));
  for (const output of outputs) {
    const defined = byKey.get(output.key);
    if (!defined) {
      throw new AcrmError(
        `signal ${definition.slug} returned unknown output key: ${output.key}`,
        ERR.INVALID_INPUT,
      );
    }
    validateOutputValue(output, defined, definition.slug);
  }
}

function validateOutputValue(
  output: ParsedRunnerOutput,
  definitionOutput: SignalOutputDefinition,
  signalSlug: string,
): void {
  const failType = (expected: string): never => {
    throw new AcrmError(
      `signal ${signalSlug} returned invalid ${definitionOutput.type} value for ${output.key}: ${String(output.value)} (expected ${expected})`,
      ERR.INVALID_INPUT,
    );
  };
  switch (definitionOutput.type) {
    case "text":
      if (typeof output.value !== "string" || !output.value.trim()) {
        failType("a non-empty string");
      }
      return;
    case "number":
      if (typeof output.value !== "number" || !Number.isFinite(output.value)) {
        failType("a finite JSON number");
      }
      return;
    case "url":
      if (typeof output.value !== "string" || !isHttpUrl(output.value)) {
        failType("an absolute http(s) URL string");
      }
      return;
    case "date":
      if (typeof output.value !== "string" || !isIsoDate(output.value)) {
        failType("YYYY-MM-DD");
      }
      return;
    case "timestamp":
      if (typeof output.value !== "string" || !isIsoTimestamp(output.value)) {
        failType("an ISO-8601 timestamp string with timezone");
      }
      return;
    case "status":
    case "select": {
      const raw = typeof output.value === "string" ? output.value : "";
      const optionIds = new Set((definitionOutput.options ?? []).map((option) => option.id));
      if (!raw || !optionIds.has(raw)) {
        failType(`one of: ${(definitionOutput.options ?? []).map((option) => option.id).join(", ")}`);
      }
      return;
    }
  }
}

function isConfidence(value: string): boolean {
  return value === "low" || value === "medium" || value === "high";
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isIsoTimestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function extractJson(raw: string): string {
  const trimmed = stripAnsi(raw).trim();
  if (trimmed.startsWith("{")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```/);
  if (fenced) return fenced[1]!.trim();
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

function outputExcerpt(raw: string): string {
  const text = stripAnsi(raw).replace(/\s+/g, " ").trim();
  if (!text) return "(empty stdout)";
  return JSON.stringify(text.length > 300 ? `${text.slice(0, 300)}…` : text);
}

function stripAnsi(raw: string): string {
  return raw.replace(/\u001b\[[0-9;]*m/g, "");
}

function textExcerpt(raw: string, limit: number): string {
  const text = stripAnsi(raw).replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function sanitizeRunnerOutputForLog(raw: string): string {
  return stripAnsi(raw)
    .split(/\r?\n/)
    .flatMap((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) return line ? [line] : [];
      try {
        const sanitized = sanitizeClaudeStreamObject(JSON.parse(trimmed) as unknown);
        return sanitized ? [JSON.stringify(sanitized)] : [];
      } catch {
        return [line];
      }
    })
    .join("\n");
}

function sanitizeRunnerOutputChunk(
  previousRemainder: string,
  chunk: string,
): { text: string; remainder: string } {
  const combined = previousRemainder + chunk;
  const lines = combined.split(/\n/);
  const hasCompleteLine = combined.endsWith("\n");
  const remainder = hasCompleteLine ? "" : (lines.pop() ?? "");
  const complete = hasCompleteLine ? lines : lines;
  const text = sanitizeRunnerOutputForLog(complete.join("\n"));
  return {
    text: text ? `${text}\n` : "",
    remainder,
  };
}

function sanitizeClaudeStreamObject(value: unknown): unknown | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const item = value as Record<string, unknown>;
  if (item.type !== "assistant") return value;
  const message = item.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return value;
  const messageObject = message as Record<string, unknown>;
  const content = messageObject.content;
  if (!Array.isArray(content)) return value;
  const safeContent = content
    .filter((block) => !isThinkingBlock(block))
    .map((block) => stripSignature(block));
  if (safeContent.length === 0) return null;
  return {
    ...item,
    message: {
      ...messageObject,
      content: safeContent,
    },
  };
}

function isThinkingBlock(block: unknown): boolean {
  if (!block || typeof block !== "object" || Array.isArray(block)) return false;
  const type = (block as Record<string, unknown>).type;
  return type === "thinking" || type === "redacted_thinking";
}

function stripSignature(block: unknown): unknown {
  if (!block || typeof block !== "object" || Array.isArray(block)) return block;
  const { signature: _signature, ...rest } = block as Record<string, unknown>;
  return rest;
}

function teeRunnerChunk(chunk: string): void {
  const logPath = process.env.ACRM_SIGNAL_LOG_PATH;
  if (!logPath) {
    process.stderr.write(chunk);
    return;
  }
  try {
    appendFileSync(logPath, chunk, "utf8");
  } catch {
    // Best-effort diagnostics should never fail the signal run itself.
  }
}

class SignalRunnerProcessError extends Error {
  num_turns?: number;
  estimated_num_turns?: number;
  stdout_excerpt?: string;
  stderr_excerpt?: string;

  constructor(message: string, stdout: string, stderr: string) {
    super(message);
    this.name = "SignalRunnerProcessError";
    const metrics = runnerTurnMetrics(stdout);
    if (metrics.num_turns !== undefined) this.num_turns = metrics.num_turns;
    if (metrics.estimated_num_turns !== undefined) {
      this.estimated_num_turns = metrics.estimated_num_turns;
    }
    const stdoutExcerpt = textExcerpt(stdout, RUNNER_STDOUT_EXCERPT_CHARS);
    if (stdoutExcerpt) this.stdout_excerpt = stdoutExcerpt;
    const excerpt = textExcerpt(stderr, RUNNER_STDERR_EXCERPT_CHARS);
    if (excerpt) this.stderr_excerpt = excerpt;
  }
}

class SignalRunnerOutputError extends Error {
  num_turns?: number;
  estimated_num_turns?: number;
  stdout_excerpt?: string;

  constructor(error: unknown, stdout: string) {
    super(error instanceof Error ? error.message : String(error));
    this.name = error instanceof Error ? error.name : "SignalRunnerOutputError";
    const metrics = runnerTurnMetrics(stdout);
    if (metrics.num_turns !== undefined) this.num_turns = metrics.num_turns;
    if (metrics.estimated_num_turns !== undefined) {
      this.estimated_num_turns = metrics.estimated_num_turns;
    }
    const excerpt = textExcerpt(sanitizeRunnerOutputForLog(stdout), RUNNER_STDOUT_EXCERPT_CHARS);
    if (excerpt) this.stdout_excerpt = excerpt;
  }
}

function signalFailureFromError(
  error: unknown,
): { message: string; stdout_excerpt?: string; stderr_excerpt?: string } & RunnerTurnMetrics {
  const message = error instanceof Error ? error.message : String(error);
  const num_turns =
    error &&
    typeof error === "object" &&
    "num_turns" in error &&
    typeof (error as { num_turns?: unknown }).num_turns === "number"
      ? (error as { num_turns: number }).num_turns
      : undefined;
  const estimated_num_turns =
    error &&
    typeof error === "object" &&
    "estimated_num_turns" in error &&
    typeof (error as { estimated_num_turns?: unknown }).estimated_num_turns === "number"
      ? (error as { estimated_num_turns: number }).estimated_num_turns
      : undefined;
  const stdout_excerpt =
    error &&
    typeof error === "object" &&
    "stdout_excerpt" in error &&
    typeof (error as { stdout_excerpt?: unknown }).stdout_excerpt === "string"
      ? (error as { stdout_excerpt: string }).stdout_excerpt
      : undefined;
  const stderr_excerpt =
    error &&
    typeof error === "object" &&
    "stderr_excerpt" in error &&
    typeof (error as { stderr_excerpt?: unknown }).stderr_excerpt === "string"
      ? (error as { stderr_excerpt: string }).stderr_excerpt
      : undefined;
  return {
    message,
    ...runnerTurnMetricFields({ num_turns, estimated_num_turns }),
    ...(stdout_excerpt ? { stdout_excerpt } : {}),
    ...(stderr_excerpt ? { stderr_excerpt } : {}),
  };
}

function normalizeCitations(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((citation) => {
    if (typeof citation === "string") return citation.trim().length > 0;
    return citation && typeof citation === "object" && !Array.isArray(citation);
  });
}

function parseJson(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function defaultRunner(
  prompt: string,
  context: SignalRunnerContext,
): Promise<string> {
  const command = runnerCommandFromEnv();
  if (!process.env.ACRM_SIGNAL_RUNNER) {
    command.push(
      "--json-schema",
      JSON.stringify(signalResponseSchema(context.signal, context.requested_outputs)),
    );
  }
  return runCommand([...command, prompt]);
}

function runnerCommandFromEnv(): string[] {
  const raw = process.env.ACRM_SIGNAL_RUNNER;
  if (!raw) {
    return [
      ...DEFAULT_RUNNER,
      "--model",
      signalRunsModelFromEnv(),
    ];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new AcrmError(
      `ACRM_SIGNAL_RUNNER must be a JSON string array: ${e instanceof Error ? e.message : String(e)}`,
      ERR.INVALID_INPUT,
    );
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((part) => typeof part === "string" && part.length > 0)
  ) {
    throw new AcrmError(
      "ACRM_SIGNAL_RUNNER must be a non-empty JSON string array",
      ERR.INVALID_INPUT,
    );
  }
  return parsed as string[];
}

function signalRunsModelFromEnv(): string {
  const raw = process.env.SIGNAL_RUNS_MODEL?.trim();
  return raw || DEFAULT_SIGNAL_RUNS_MODEL;
}

function signalResponseSchema(
  definition: SignalDefinition,
  requestedKeys: string[],
): Record<string, unknown> {
  const requested = new Set(requestedKeys);
  const outputs = definition.outputs.filter((output) => requested.has(output.key));
  return {
    type: "object",
    additionalProperties: false,
    required: ["outputs"],
    properties: {
      outputs: {
        type: "array",
        items: {
          anyOf: outputs.map((output) => outputSchema(output)),
        },
      },
    },
  };
}

function outputSchema(output: SignalOutputDefinition): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["key", "value", "confidence", "citations", "reasoning"],
    properties: {
      key: { enum: [output.key] },
      value: valueSchema(output),
      confidence: { enum: ["low", "medium", "high"] },
      citations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true,
          required: ["url"],
          properties: {
            url: { type: "string", minLength: 1 },
            title: { type: "string" },
            quote: { type: "string" },
          },
        },
      },
      reasoning: { type: "string", minLength: 1 },
      notes: { type: "string" },
    },
  };
}

function valueSchema(output: SignalOutputDefinition): Record<string, unknown> {
  switch (output.type) {
    case "number":
      return { type: "number" };
    case "url":
      return { type: "string", pattern: "^https?://" };
    case "date":
      return { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
    case "timestamp":
      return {
        type: "string",
        pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$",
      };
    case "status":
    case "select":
      return { enum: (output.options ?? []).map((option) => option.id) };
    case "text":
      return { type: "string", minLength: 1 };
  }
}

async function runCommand(command: string[]): Promise<string> {
  const [bin, ...args] = command;
  if (!bin) throw new AcrmError("empty signal runner command", ERR.INVALID_INPUT);
  return await new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env: process.env,
    });
    let stdout = "";
    let stdoutLog = "";
    let stdoutLogRemainder = "";
    let stderr = "";
    const flushStdoutLog = () => {
      const text = sanitizeRunnerOutputForLog(stdoutLogRemainder);
      stdoutLogRemainder = "";
      if (!text) return;
      const line = `${text}\n`;
      stdoutLog += line;
      teeRunnerChunk(line);
    };
    const timer = setTimeout(() => {
      flushStdoutLog();
      child.kill();
      reject(
        new SignalRunnerProcessError(
          `signal runner timed out after ${DEFAULT_RUNNER_TIMEOUT_MS}ms`,
          stdoutLog,
          stderr,
        ),
      );
    }, DEFAULT_RUNNER_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const sanitized = sanitizeRunnerOutputChunk(stdoutLogRemainder, chunk);
      stdoutLogRemainder = sanitized.remainder;
      if (sanitized.text) {
        stdoutLog += sanitized.text;
        teeRunnerChunk(sanitized.text);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      teeRunnerChunk(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      flushStdoutLog();
      reject(new SignalRunnerProcessError(error.message, stdoutLog, stderr));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      flushStdoutLog();
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new SignalRunnerProcessError(
            `signal runner exited with code ${code}`,
            stdoutLog,
            stderr,
          ),
        );
      }
    });
  });
}

async function runWithConcurrency(
  tasks: Array<() => Promise<void>>,
  concurrency: number,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (next < tasks.length) {
      const task = tasks[next++]!;
      await task();
    }
  });
  await Promise.all(workers);
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}
