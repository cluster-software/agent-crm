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
import * as readline from "node:readline";

const TTL_MS = 24 * 60 * 60 * 1000;
const LOCK_TTL_MS = 60 * 1000;
const RELEASES_URL =
  "https://github.com/cluster-software/agent-crm/releases/latest";

export type UpdateCheckCache = {
  checked_at: number;
  latest_version: string;
  // Set when the user picks "Skip" at the interactive prompt. We keep the
  // prompt suppressed for this version only — a newer published version
  // will replace latest_version and re-trigger the prompt next time.
  skipped_version?: string;
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

function writeCacheRaw(cache: UpdateCheckCache): void {
  try {
    const dir = configDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = cachePath();
    writeFileSync(file, JSON.stringify(cache) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(file, 0o600);
  } catch {
    // Swallow — we'd rather skip future checks than break this command.
  }
}

export function writeCache(latest: string): void {
  // Background-worker entry point — overwrites the cache wholesale, dropping
  // any prior skipped_version because a fresh fetch may have surfaced a new
  // latest that the user hasn't dismissed yet.
  writeCacheRaw({ checked_at: Date.now(), latest_version: latest });
}

function markSkipped(version: string): void {
  const existing = readCache();
  if (!existing) return;
  writeCacheRaw({ ...existing, skipped_version: version });
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

// Interactive TTY prompt — Codex-style heading, release notes link, and a
// 2-option selector. Non-TTY callers (agents, pipes, CI) fall back to the
// plain stderr warning from notifyIfOutdated.
export async function promptIfOutdated(currentVersion: string): Promise<void> {
  if (isOptedOut()) return;
  if (!isComparableVersion(currentVersion)) return;
  const cached = readCache();
  if (!cached) return;
  if (compareVersions(cached.latest_version, currentVersion) <= 0) return;

  const interactive =
    Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
  if (!interactive) {
    notifyIfOutdated(currentVersion);
    return;
  }

  // The user already chose "Skip" for this exact latest version — stay quiet
  // until a newer one is published.
  if (cached.skipped_version === cached.latest_version) return;

  const choice = await renderPrompt(currentVersion, cached.latest_version);
  if (choice === "update") {
    await runUpdate();
  } else {
    markSkipped(cached.latest_version);
  }
}

type PromptChoice = "update" | "skip";

function renderPrompt(
  current: string,
  latest: string,
): Promise<PromptChoice> {
  const out = process.stderr;
  const noColor = Boolean(process.env.NO_COLOR);
  const c = (code: string, s: string) =>
    noColor ? s : `\x1b[${code}m${s}\x1b[0m`;
  const bold = (s: string) => c("1", s);
  const dim = (s: string) => c("2", s);
  const cyan = (s: string) => c("36", s);
  const yellow = (s: string) => c("33", s);

  const options = [
    "Update now (runs `npm install -g @agent-crm/cli@latest`)",
    "Skip",
  ];
  let selected = 0;

  // Header is drawn once; only the option block + hint redraw on keypress.
  out.write("\n");
  out.write(`${yellow("✨")} ${bold("Update available!")} ${dim(current)} → ${latest}\n`);
  out.write("\n");
  out.write(`Release notes: ${cyan(RELEASES_URL)}\n`);
  out.write("\n");

  const REDRAW_LINES = options.length + 2; // options + blank + hint

  const drawOptions = (firstPaint: boolean) => {
    if (!firstPaint) {
      for (let i = 0; i < REDRAW_LINES; i++) {
        out.write("\x1b[1A\x1b[2K");
      }
    }
    options.forEach((opt, i) => {
      const marker = i === selected ? cyan("›") : " ";
      const label = `${i + 1}. ${opt}`;
      out.write(`${marker} ${i === selected ? bold(label) : label}\n`);
    });
    out.write("\n");
    out.write(dim("Press enter to continue") + "\n");
  };

  drawOptions(true);

  return new Promise<PromptChoice>((resolve) => {
    const stdin = process.stdin;
    readline.emitKeypressEvents(stdin);
    const hadRawMode = stdin.isRaw;
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();

    const cleanup = () => {
      stdin.removeListener("keypress", onKey);
      if (stdin.setRawMode) stdin.setRawMode(hadRawMode ?? false);
      stdin.pause();
      out.write("\n");
    };

    const onKey = (
      _str: string,
      key: { name?: string; ctrl?: boolean } | undefined,
    ) => {
      if (!key) return;
      if (key.ctrl && key.name === "c") {
        cleanup();
        process.exit(130);
      }
      if (key.name === "up" || key.name === "k") {
        if (selected > 0) {
          selected--;
          drawOptions(false);
        }
      } else if (key.name === "down" || key.name === "j") {
        if (selected < options.length - 1) {
          selected++;
          drawOptions(false);
        }
      } else if (key.name === "1") {
        selected = 0;
        drawOptions(false);
      } else if (key.name === "2") {
        selected = 1;
        drawOptions(false);
      } else if (key.name === "return") {
        cleanup();
        resolve(selected === 0 ? "update" : "skip");
      }
    };

    stdin.on("keypress", onKey);
  });
}

function runUpdate(): Promise<void> {
  return new Promise((resolve) => {
    const out = process.stderr;
    out.write("\nRunning `npm install -g @agent-crm/cli@latest`...\n\n");
    const child = spawn("npm", ["install", "-g", "@agent-crm/cli@latest"], {
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      if (code === 0) {
        out.write("\n✓ Updated. Please re-run your command.\n");
        process.exit(0);
      }
      out.write(
        `\nnpm install exited with code ${code}. Continuing with your command anyway.\n`,
      );
      resolve();
    });
    child.on("error", (err) => {
      out.write(
        `\nFailed to run npm install: ${err.message}. Continuing with your command anyway.\n`,
      );
      resolve();
    });
  });
}
