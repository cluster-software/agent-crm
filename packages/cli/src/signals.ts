import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readdirSync } from "node:fs";
import path from "node:path";
import { writeSignalJobStateSync, type SignalObjectSlug, type SignalRecordRef } from "@agent-crm/sdk";

export type ImportSignalResult =
  | { background: BackgroundSignalRun; warning?: never }
  | { background?: never; warning: string };

export type BackgroundSignalRun = {
  started: true;
  jobs: BackgroundSignalJob[];
};

export type BackgroundSignalJob = {
  object_slug: SignalObjectSlug;
  record_ids: string[];
  pid: number;
  log_path: string;
};

const DEFAULT_BACKGROUND_SIGNAL_CONCURRENCY = 10;
const MAX_IMPORT_SIGNAL_RECORDS = 1000;

export function signalsDirForWorkspace(workspaceFile: string): string {
  return path.join(path.dirname(workspaceFile), "signals");
}

export function startMissingSignalsForRecords(
  workspaceFile: string,
  records: SignalRecordRef[],
): ImportSignalResult | null {
  if (records.length === 0) return null;
  if (!hasSignalFiles(signalsDirForWorkspace(workspaceFile))) return null;
  try {
    const jobs = startBackgroundJobs(workspaceFile, capImportSignalRecords(records));
    if (jobs.length === 0) return null;
    return { background: { started: true, jobs } };
  } catch (e) {
    return {
      warning: e instanceof Error ? e.message : String(e),
    };
  }
}

function capImportSignalRecords(records: SignalRecordRef[]): SignalRecordRef[] {
  // TODO: use a job manifest file so import-time signals can scale beyond
  // 1,000 touched records without huge argv payloads or long local runs.
  return uniqueSignalRecords(records).slice(0, MAX_IMPORT_SIGNAL_RECORDS);
}

function uniqueSignalRecords(records: SignalRecordRef[]): SignalRecordRef[] {
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

function hasSignalFiles(signalsDir: string): boolean {
  try {
    return readdirSync(signalsDir).some((name) => name.endsWith(".md"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

function startBackgroundJobs(
  workspaceFile: string,
  records: SignalRecordRef[],
): BackgroundSignalJob[] {
  const grouped = groupRecordIds(records);
  const jobs: BackgroundSignalJob[] = [];
  for (const [object_slug, record_ids] of grouped) {
    const jobId = `import-${object_slug}-${Date.now()}`;
    const log_path = createLogPath(workspaceFile, jobId);
    const fd = openSync(log_path, "a");
    try {
      const child = spawn(process.execPath, signalRunArgs(workspaceFile, object_slug, record_ids), {
        cwd: path.dirname(workspaceFile),
        detached: true,
        env: {
          ...process.env,
          ACRM_SIGNAL_JOB_ID: jobId,
          ACRM_SIGNAL_LOG_PATH: log_path,
        },
        shell: false,
        stdio: ["ignore", fd, fd],
      });
      child.unref();
      const now = new Date().toISOString();
      writeSignalJobStateSync(workspaceFile, {
        id: jobId,
        status: "running",
        source: "cli",
        object_slug,
        record_ids,
        signalSlugs: [],
        log_path,
        started_at: now,
        updated_at: now,
        pid: child.pid ?? 0,
      });
      jobs.push({
        object_slug,
        record_ids,
        pid: child.pid ?? 0,
        log_path,
      });
    } finally {
      closeSync(fd);
    }
  }
  return jobs;
}

function groupRecordIds(records: SignalRecordRef[]): Map<SignalObjectSlug, string[]> {
  const grouped = new Map<SignalObjectSlug, string[]>();
  const seen = new Set<string>();
  for (const record of records) {
    const key = `${record.object_slug}:${record.record_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const current = grouped.get(record.object_slug) ?? [];
    current.push(record.record_id);
    grouped.set(record.object_slug, current);
  }
  return grouped;
}

function signalRunArgs(
  workspaceFile: string,
  object_slug: SignalObjectSlug,
  record_ids: string[],
): string[] {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    throw new Error("Could not find current acrm CLI entrypoint for background signals");
  }
  return [
    entrypoint,
    "-w",
    workspaceFile,
    "--json",
    "signals",
    "run",
    "--missing",
    "--object",
    object_slug,
    "--concurrency",
    String(backgroundSignalConcurrency()),
    ...record_ids.flatMap((record_id) => ["--record-id", record_id]),
  ];
}

function backgroundSignalConcurrency(): number {
  const raw = process.env.ACRM_SIGNAL_CONCURRENCY;
  if (!raw) return DEFAULT_BACKGROUND_SIGNAL_CONCURRENCY;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return DEFAULT_BACKGROUND_SIGNAL_CONCURRENCY;
  return value;
}

function createLogPath(workspaceFile: string, jobId: string): string {
  const dir = path.join(path.dirname(workspaceFile), ".cache", "signals");
  mkdirSync(dir, { recursive: true });
  return path.join(dir, `${jobId}.log`);
}
