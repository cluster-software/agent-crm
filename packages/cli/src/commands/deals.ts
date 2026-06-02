import type { Command } from "commander";
import { AcrmError, ERR } from "@agent-crm/sdk";
import { fail, ok, setJsonMode } from "../output/json.js";
import { readCloudSessionContext, type CloudSessionContext } from "../lib/cloud-workspace.js";

type DealStage = { id: string; title: string };

type DealsCreateOpts = {
  name: string;
  stage?: string;
  value?: string;
  currency?: string;
  closeDate?: string;
  nextStep?: string;
  company?: string;
  person?: string[];
};

type DealsUpdateOpts = Omit<DealsCreateOpts, "name"> & {
  name?: string;
  clear?: string[];
};

type DealsPipelineSetOpts = {
  stage?: string[];
  map?: string[];
};

export function registerDeals(program: Command): void {
  const deals = program
    .command("deals")
    .description("cloud deal operations for the Agent CRM desktop workspace");

  deals
    .command("list")
    .description("list deals from the active cloud workspace")
    .action(async () => runAction(program, () => runDealsList()));

  deals
    .command("show <deal_id>")
    .description("show one deal")
    .action(async (dealId: string) => runAction(program, () => runDealsShow(dealId)));

  deals
    .command("create")
    .description("create a deal in the active cloud workspace")
    .requiredOption("--name <name>", "deal name")
    .option("--stage <stage>", "stage id or title")
    .option("--value <amount>", "deal value")
    .option("--currency <code>", "currency code (default: USD)")
    .option("--close-date <YYYY-MM-DD>", "expected close date")
    .option("--next-step <text>", "next step")
    .option("--company <record_id>", "associated company record id")
    .option("--person <record_id>", "associated person record id; repeatable", collect, [] as string[])
    .action(async (opts: DealsCreateOpts) => runAction(program, () => runDealsCreate(opts)));

  deals
    .command("update <deal_id>")
    .description("update a deal in the active cloud workspace")
    .option("--name <name>", "deal name")
    .option("--stage <stage>", "stage id or title")
    .option("--value <amount>", "deal value")
    .option("--currency <code>", "currency code")
    .option("--close-date <YYYY-MM-DD>", "expected close date")
    .option("--next-step <text>", "next step")
    .option("--company <record_id>", "associated company record id")
    .option("--person <record_id>", "associated person record id; repeatable", collect, [] as string[])
    .option("--clear <field>", "clear a deal field; repeatable", collect, [] as string[])
    .action(async (dealId: string, opts: DealsUpdateOpts) => runAction(program, () => runDealsUpdate(dealId, opts)));

  deals
    .command("delete <deal_id>")
    .description("archive a deal")
    .action(async (dealId: string) => runAction(program, () => runDealsDelete(dealId)));

  const pipeline = deals
    .command("pipeline")
    .description("inspect or configure deal pipeline stages");

  pipeline
    .command("list")
    .description("show configured deal stages and counts")
    .action(async () => runAction(program, () => runDealsPipelineList()));

  pipeline
    .command("context")
    .description("show bounded workspace context useful for pipeline setup")
    .action(async () => runAction(program, () => runDealsPipelineContext()));

  pipeline
    .command("set")
    .description("replace/reorder deal pipeline stages")
    .requiredOption("--stage <id[:Title]>", "stage id and optional title; repeatable", collect, [] as string[])
    .option("--map <old:new>", "migrate existing deals from old stage id to new stage id; repeatable", collect, [] as string[])
    .action(async (opts: DealsPipelineSetOpts) => runAction(program, () => runDealsPipelineSet(opts)));
}

async function runAction(program: Command, action: () => Promise<unknown>): Promise<void> {
  const root = program.opts() as { json?: boolean };
  setJsonMode(root.json);
  try {
    ok(await action());
  } catch (e) {
    if (e instanceof AcrmError) fail(e.message, e.code, e.hint);
    else fail(e instanceof Error ? e.message : String(e), ERR.UNHANDLED);
    process.exit(1);
  }
}

async function runDealsList(): Promise<unknown> {
  return requestDealsApi("/app/workspace/deals");
}

async function runDealsShow(dealId: string): Promise<unknown> {
  return requestDealsApi(`/app/workspace/deals/${encodeURIComponent(dealId)}`);
}

async function runDealsCreate(opts: DealsCreateOpts): Promise<unknown> {
  return requestDealsApi("/app/workspace/deals", {
    method: "POST",
    body: JSON.stringify(compact({
      name: opts.name,
      stage: opts.stage,
      value: parseOptionalNumber(opts.value, "value"),
      currency: opts.currency,
      close_date: opts.closeDate,
      next_step: opts.nextStep,
      associated_company: opts.company,
      associated_people: opts.person,
      source: "cli:deals-create"
    }))
  });
}

async function runDealsUpdate(dealId: string, opts: DealsUpdateOpts): Promise<unknown> {
  return requestDealsApi(`/app/workspace/deals/${encodeURIComponent(dealId)}`, {
    method: "PATCH",
    body: JSON.stringify(compact({
      name: opts.name,
      stage: opts.stage,
      value: parseOptionalNumber(opts.value, "value"),
      currency: opts.currency,
      close_date: opts.closeDate,
      next_step: opts.nextStep,
      associated_company: opts.company,
      associated_people: opts.person && opts.person.length > 0 ? opts.person : undefined,
      clear: opts.clear,
      source: "cli:deals-update"
    }))
  });
}

async function runDealsDelete(dealId: string): Promise<unknown> {
  return requestDealsApi(`/app/workspace/deals/${encodeURIComponent(dealId)}`, {
    method: "DELETE"
  });
}

async function runDealsPipelineList(): Promise<unknown> {
  return requestDealsApi("/app/workspace/deals/pipeline");
}

async function runDealsPipelineContext(): Promise<unknown> {
  return requestDealsApi("/app/workspace/deals/pipeline/context");
}

async function runDealsPipelineSet(opts: DealsPipelineSetOpts): Promise<unknown> {
  return requestDealsApi("/app/workspace/deals/pipeline", {
    method: "PUT",
    body: JSON.stringify({
      stages: (opts.stage ?? []).map(parseStage),
      migrations: parseMigrations(opts.map ?? []),
      source: "cli:deals-pipeline-set"
    })
  });
}

async function requestDealsApi(path: string, init: RequestInit = {}): Promise<unknown> {
  const session = requireCloudSession();
  const url = new URL(path, session.syncEngineUrl);
  const response = await fetch(url.toString(), {
    ...init,
    headers: {
      authorization: `Bearer ${session.desktopSessionToken}`,
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers
    }
  });
  const payload = await response.json().catch(() => undefined) as
    | { ok?: unknown; error?: unknown; [key: string]: unknown }
    | undefined;
  if (!response.ok || payload?.ok !== true) {
    throw new AcrmError(
      "failed to run deals command",
      ERR.IMPORT,
      typeof payload?.error === "string" ? payload.error : `sync engine returned HTTP ${response.status}`
    );
  }
  const { ok: _ok, ...data } = payload;
  return data;
}

function requireCloudSession(): CloudSessionContext {
  const session = readCloudSessionContext();
  if (!session) {
    throw new AcrmError(
      "acrm deals commands require an Agent CRM cloud desktop session",
      ERR.INVALID_INPUT,
      "Open the Agent CRM app and run this command from its terminal so ACRM_DESKTOP_SESSION_TOKEN and ACRM_CLOUD_WORKSPACE_ID are available."
    );
  }
  return session;
}

function parseStage(raw: string): DealStage {
  const index = raw.indexOf(":");
  const rawId = (index < 0 ? raw : raw.slice(0, index)).trim();
  const id = stageKey(rawId);
  const title = (index < 0 ? titleCase(rawId) : raw.slice(index + 1).trim()) || titleCase(id);
  if (!id) throw new AcrmError("invalid --stage value", ERR.INVALID_INPUT);
  return { id, title };
}

function parseMigrations(values: string[]): Record<string, string> {
  const migrations: Record<string, string> = {};
  for (const raw of values) {
    const index = raw.indexOf(":");
    if (index <= 0 || index === raw.length - 1) {
      throw new AcrmError(`invalid --map value: ${raw} (expected old:new)`, ERR.INVALID_INPUT);
    }
    const from = stageKey(raw.slice(0, index));
    const to = stageKey(raw.slice(index + 1));
    if (!from || !to) throw new AcrmError(`invalid --map value: ${raw} (expected old:new)`, ERR.INVALID_INPUT);
    migrations[from] = to;
  }
  return migrations;
}

function parseOptionalNumber(value: string | undefined, label: string): number | undefined {
  if (value == null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new AcrmError(`invalid --${label}: ${value}`, ERR.INVALID_INPUT);
  return parsed;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function compact(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) =>
    value !== undefined && (!Array.isArray(value) || value.length > 0)
  ));
}

function titleCase(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function stageKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export const __test = {
  parseStage,
  parseMigrations,
  requireCloudSession,
  runDealsPipelineSet,
  runDealsCreate,
  runDealsUpdate
};
