import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentName } from "./agents.js";

export interface LockfileEntry {
  sourceType: "bundled";
  hash: string;
  installedAt: string;
  // Records every agent dir we wrote this skill to. Used as the cleanup
  // allowlist: we only ever rm paths we put here, never anything else in the
  // user's skills dirs.
  agents: Partial<Record<AgentName, { path: string }>>;
}

export interface Lockfile {
  schemaVersion: 1;
  acrmVersion: string;
  skills: Record<string, LockfileEntry>;
}

export const LOCK_PATH = join(homedir(), ".acrm", "skills.lock.json");

export async function readLockfile(): Promise<Lockfile> {
  try {
    const parsed = JSON.parse(await readFile(LOCK_PATH, "utf-8"));
    if (parsed?.schemaVersion === 1) return parsed as Lockfile;
  } catch {
    // missing or malformed — start fresh
  }
  return { schemaVersion: 1, acrmVersion: "", skills: {} };
}

export async function writeLockfile(lock: Lockfile): Promise<void> {
  await mkdir(dirname(LOCK_PATH), { recursive: true });
  await writeFile(LOCK_PATH, JSON.stringify(lock, null, 2) + "\n");
}
