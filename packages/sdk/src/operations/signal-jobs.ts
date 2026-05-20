import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import type { SignalObjectSlug } from "./signals.js";

export type SignalJobStatus = "running" | "succeeded" | "failed";

export type SignalRunJobState = {
  id: string;
  status: SignalJobStatus;
  source: "cli" | "app";
  object_slug?: SignalObjectSlug;
  record_ids: string[];
  signalSlugs: string[];
  log_path: string;
  started_at: string;
  updated_at: string;
  completed_at?: string;
  pid?: number;
  error?: string;
};

export function signalJobsDirForWorkspace(workspaceFile: string): string {
  return path.join(path.dirname(workspaceFile), ".cache", "signals", "jobs");
}

export async function writeSignalJobState(
  workspaceFile: string,
  job: SignalRunJobState,
): Promise<void> {
  const file = signalJobPath(workspaceFile, job.id);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(job, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

export function writeSignalJobStateSync(
  workspaceFile: string,
  job: SignalRunJobState,
): void {
  const file = signalJobPath(workspaceFile, job.id);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(job, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

export async function finishSignalJob(
  workspaceFile: string,
  id: string,
  status: Exclude<SignalJobStatus, "running">,
  error?: string,
): Promise<void> {
  const existing = await readSignalJobState(workspaceFile, id);
  if (!existing) return;
  const now = new Date().toISOString();
  await writeSignalJobState(workspaceFile, {
    ...existing,
    status,
    updated_at: now,
    completed_at: now,
    ...(error ? { error } : {}),
  });
}

export async function listRunningSignalJobs(workspaceFile: string): Promise<SignalRunJobState[]> {
  const jobs = await listSignalJobStates(workspaceFile);
  const running: SignalRunJobState[] = [];
  for (const job of jobs) {
    if (job.status !== "running") continue;
    if (!isProcessAlive(job.pid)) {
      await finishSignalJob(
        workspaceFile,
        job.id,
        "failed",
        "Signal job process is no longer running.",
      ).catch(() => undefined);
      continue;
    }
    running.push(job);
  }
  return running.sort((a, b) => a.started_at.localeCompare(b.started_at));
}

async function listSignalJobStates(workspaceFile: string): Promise<SignalRunJobState[]> {
  const dir = signalJobsDirForWorkspace(workspaceFile);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const jobs: SignalRunJobState[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as SignalRunJobState;
      if (parsed?.id && parsed?.status && Array.isArray(parsed.record_ids)) {
        jobs.push(parsed);
      }
    } catch {
      // Ignore partial/corrupt job files; they should not break workspace loading.
    }
  }
  return jobs;
}

async function readSignalJobState(
  workspaceFile: string,
  id: string,
): Promise<SignalRunJobState | null> {
  try {
    const parsed = JSON.parse(
      await readFile(signalJobPath(workspaceFile, id), "utf8"),
    ) as SignalRunJobState;
    return parsed?.id ? parsed : null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

function signalJobPath(workspaceFile: string, id: string): string {
  return path.join(signalJobsDirForWorkspace(workspaceFile), `${safeJobId(id)}.json`);
}

function safeJobId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || pid < 1) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
