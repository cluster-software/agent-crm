// Background update notifier — same pattern as npm's `update-notifier`:
//   1. On every CLI startup, read a tiny JSON cache. If it shows a newer
//      published version than what's installed, print a warning to STDERR
//      (never stdout, so --json output stays clean).
//   2. If the cache is missing or older than TTL_MS, spawn a detached,
//      unref'd child process that fetches the npm registry and rewrites
//      the cache. The current command returns immediately; the *next*
//      invocation sees the fresh result.
//
// All failures are swallowed silently. An update check must never break,
// slow down, or fail an acrm command.
import { readFileSync, writeFileSync, mkdirSync, statSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const TTL_MS = 24 * 60 * 60 * 1000;
const LOCK_TTL_MS = 60 * 1000;

export type UpdateCheckCache = {
  checked_at: number;
  latest_version: string;
};

export function configDir(): string {
  if (process.env.ACRM_CONFIG_DIR && process.env.ACRM_CONFIG_DIR.trim().length) {
    return process.env.ACRM_CONFIG_DIR;
  }
  return path.join(homedir(), ".config", "acrm");
}

export function cachePath(): string {
  return path.join(configDir(), "update-check.json");
}

export function lockPath(): string {
  return path.join(configDir(), "update-check.lock");
}

// Parse "0.7.0" → [0, 7, 0]. Returns null for anything non-numeric or with a
// pre-release suffix ("0.9.0-dev", "1.0.0-rc.1") — those should not trigger
// a warning at all.
export function parseVersion(v: string): [number, number, number] | null {
  if (typeof v !== "string") return null;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// Returns 1 if a > b, -1 if a < b, 0 if equal. Throws never — non-parseable
// inputs return 0 so callers default to "do nothing".
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

function readCache(): UpdateCheckCache | null {
  try {
    const raw = readFileSync(cachePath(), "utf8");
    const parsed = JSON.parse(raw) as UpdateCheckCache;
    if (
      !parsed ||
      typeof parsed.checked_at !== "number" ||
      typeof parsed.latest_version !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeCache(latest: string): void {
  try {
    const dir = configDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = cachePath();
    const payload: UpdateCheckCache = {
      checked_at: Date.now(),
      latest_version: latest,
    };
    writeFileSync(file, JSON.stringify(payload) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(file, 0o600);
  } catch {
    // Swallow — we'd rather skip future checks than break this command.
  }
}

function isOptedOut(): boolean {
  return Boolean(
    process.env.ACRM_NO_UPDATE_CHECK ||
      process.env.NO_UPDATE_NOTIFIER ||
      process.env.CI,
  );
}

// Pre-release / dev builds should not nag (e.g. when running `tsx src/...`
// against a 0.9.0 install but the published version is 0.9.0 too).
function isComparableVersion(v: string): boolean {
  return parseVersion(v) !== null;
}

export function notifyIfOutdated(
  currentVersion: string,
  stderr: NodeJS.WritableStream = process.stderr,
): void {
  if (isOptedOut()) return;
  if (!isComparableVersion(currentVersion)) return;
  const cached = readCache();
  if (!cached) return;
  if (compareVersions(cached.latest_version, currentVersion) <= 0) return;
  stderr.write(
    `\n⚠ A newer @agent-crm/cli is available: ${cached.latest_version} (you are using ${currentVersion}).\n` +
      `  Run: npm install -g @agent-crm/cli@latest\n\n`,
  );
}

function isCacheStale(): boolean {
  const cached = readCache();
  if (!cached) return true;
  return Date.now() - cached.checked_at > TTL_MS;
}

// Returns false if another invocation already holds the lock recently —
// prevents two near-simultaneous commands from both spawning workers.
function tryAcquireLock(): boolean {
  try {
    const p = lockPath();
    try {
      const s = statSync(p);
      if (Date.now() - s.mtimeMs < LOCK_TTL_MS) return false;
    } catch {
      // ENOENT — fall through to create the lock.
    }
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    writeFileSync(p, String(Date.now()), { encoding: "utf8", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

// Spawn the refresh worker as a detached, unref'd child. Returns immediately.
// The worker writes the cache file when it finishes; the next acrm invocation
// will pick it up.
export function scheduleBackgroundRefreshIfStale(
  currentVersion: string,
  opts: { workerPath?: string; spawnFn?: typeof spawn } = {},
): boolean {
  if (isOptedOut()) return false;
  if (!isComparableVersion(currentVersion)) return false;
  if (!isCacheStale()) return false;
  if (!tryAcquireLock()) return false;

  const worker = opts.workerPath ?? defaultWorkerPath();
  const spawnFn = opts.spawnFn ?? spawn;
  try {
    const child = spawnFn(process.execPath, [worker], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// The compiled worker sits next to this file's compiled output:
//   dist/lib/update-check.js  →  dist/scripts/refresh-version-cache.js
function defaultWorkerPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "scripts", "refresh-version-cache.js");
}
