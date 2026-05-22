import path from "node:path";
import type { Command } from "commander";
import {
  AcrmError,
  ERR,
  Workspace,
  ensureSignalAttributes,
  finishSignalJob,
  loadSignalDefinitions,
  runSignals,
  type SignalObjectSlug,
} from "@agent-crm/sdk";
import { fail, ok, setJsonMode } from "../output/json.js";
import { signalsDirForWorkspace } from "../signals.js";
import { resolveWorkspacePath } from "../workspace-resolve.js";

function collect(value: string, previous: string[]): string[] {
  return [...(previous ?? []), value];
}

function parseObject(value: string | undefined): SignalObjectSlug | undefined {
  if (!value) return undefined;
  if (value === "people" || value === "companies") return value;
  throw new AcrmError(
    `invalid --object: ${value} (expected people or companies)`,
    ERR.INVALID_INPUT,
  );
}

function parsePositiveInt(value: string | undefined, fallback?: number): number | undefined {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new AcrmError(`expected positive integer, got: ${value}`, ERR.INVALID_INPUT);
  }
  return n;
}

function handleError(e: unknown): never {
  if (e instanceof AcrmError) fail(e.message, e.code, e.hint);
  else fail(e instanceof Error ? e.message : String(e), ERR.UNHANDLED);
  process.exit(1);
}

export function registerSignals(program: Command): void {
  const signals = program
    .command("signals")
    .description(
      "list, sync, and run local multi-output signal definitions from <workspace>/signals/*.md.",
    );

  signals
    .command("list")
    .description("list signal definitions for the current workspace")
    .action(async () => {
      const root = program.opts() as { json?: boolean; workspace?: string };
      setJsonMode(root.json);
      try {
        const workspaceFile = resolveWorkspacePath(root.workspace);
        const definitions = await loadSignalDefinitions(
          signalsDirForWorkspace(workspaceFile),
        );
        ok({
          count: definitions.length,
          signals: definitions.map((definition) => ({
            slug: definition.slug,
            title: definition.title,
            object_slug: definition.object_slug,
            path: path.relative(process.cwd(), definition.path),
            outputs: definition.outputs,
          })),
        });
      } catch (e) {
        handleError(e);
      }
    });

  signals
    .command("sync")
    .description("create or update CRM attributes declared by signal outputs")
    .action(async () => {
      const root = program.opts() as { json?: boolean; workspace?: string };
      setJsonMode(root.json);
      let ws: Workspace | null = null;
      try {
        const workspaceFile = resolveWorkspacePath(root.workspace);
        const definitions = await loadSignalDefinitions(
          signalsDirForWorkspace(workspaceFile),
        );
        ws = await Workspace.open(workspaceFile);
        const result = await ensureSignalAttributes(ws, definitions);
        ok(result);
      } catch (e) {
        handleError(e);
      } finally {
        await ws?.close().catch(() => undefined);
      }
    });

  signals
    .command("run")
    .description("run local signal bundles against people or companies")
    .option("--missing", "fill only missing output fields (default)")
    .option("--force", "refresh all output fields, even when current values exist")
    .option("--signal <slug>", "run only a specific signal; repeatable", collect, [] as string[])
    .option("--object <people|companies>", "restrict records by object")
    .option("--record-id <id>", "run against one record_id; repeatable", collect, [] as string[])
    .option("--limit <n>", "maximum record-signal runs")
    .option("--concurrency <n>", "number of runner processes at a time", "1")
    .addHelpText(
      "after",
      `
Environment:
  SIGNAL_RUNS_MODEL       Claude model passed to the default signal runner (default: sonnet)
  ACRM_SIGNAL_RUNNER      JSON string array override for the full runner command

Default runner:
  Uses claude -p with WebSearch and WebFetch. Bash is exposed only for commands
  starting with agent-browser via Claude Code's allowed tool pattern:
  Bash(agent-browser:*)
`,
    )
    .action(
      async (opts: {
        missing?: boolean;
        force?: boolean;
        signal?: string[];
        object?: string;
        recordId?: string[];
        limit?: string;
        concurrency?: string;
      }) => {
        const root = program.opts() as { json?: boolean; workspace?: string };
        setJsonMode(root.json);
        let ws: Workspace | null = null;
        let workspaceFile: string | undefined;
        try {
          const object_slug = parseObject(opts.object);
          const record_ids = opts.recordId ?? [];
          if (record_ids.length > 0 && !object_slug) {
            throw new AcrmError(
              "--object is required when --record-id is provided",
              ERR.INVALID_INPUT,
            );
          }
          workspaceFile = resolveWorkspacePath(root.workspace);
          ws = await Workspace.open(workspaceFile);
          const result = await runSignals(ws, {
            signalsDir: signalsDirForWorkspace(workspaceFile),
            mode: opts.force ? "force" : "missing",
            signalSlugs: opts.signal?.length ? opts.signal : undefined,
            object_slug,
            record_ids: record_ids.length ? record_ids : undefined,
            limit: parsePositiveInt(opts.limit),
            concurrency: parsePositiveInt(opts.concurrency, 1),
          });
          await finishEnvSignalJob(workspaceFile, result.runs_failed > 0 ? "failed" : "succeeded");
          ok(result);
        } catch (e) {
          if (workspaceFile) {
            await finishEnvSignalJob(
              workspaceFile,
              "failed",
              e instanceof Error ? e.message : String(e),
            ).catch(() => undefined);
          }
          handleError(e);
        } finally {
          await ws?.close().catch(() => undefined);
        }
      },
    );
}

async function finishEnvSignalJob(
  workspaceFile: string,
  status: "succeeded" | "failed",
  error?: string,
): Promise<void> {
  const jobId = process.env.ACRM_SIGNAL_JOB_ID;
  if (!jobId) return;
  await finishSignalJob(workspaceFile, jobId, status, error).catch(() => undefined);
}
