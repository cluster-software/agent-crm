#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PROD_SYNC_ENGINE_URL = "https://agent-crm-sync-engine.onrender.com";
const DEFAULT_PORT = "8000";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const AGENT_CRM_REPO = resolve(SCRIPT_DIR, "..");
const DEV_DIR = join(AGENT_CRM_REPO, ".agent-crm-dev");
const DEV_BIN_DIR = join(DEV_DIR, "bin");
const DEV_CLAUDE_CONFIG_DIR = join(DEV_DIR, "claude");
const USER_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

const appRepo = resolve(AGENT_CRM_REPO, options.appRepo ?? process.env.APP_REPO ?? "../agent-crm-app");
const syncRepo = resolve(AGENT_CRM_REPO, options.syncRepo ?? process.env.SYNC_REPO ?? "../agent-crm-sync-engine");
const syncMode = options.sync ?? process.env.SYNC ?? "local";
const syncPort = options.port ?? process.env.PORT ?? DEFAULT_PORT;
const syncUrl = options.syncUrl ?? process.env.SYNC_URL ?? (
  syncMode === "prod" ? DEFAULT_PROD_SYNC_ENGINE_URL : `http://localhost:${syncPort}`
);
const skills = options.skills ?? process.env.SKILLS;
const claudeSkills = options.claudeSkills ?? process.env.CLAUDE_SKILLS ?? "local";
const skipSyncBuild = Boolean(options.skipSyncBuild || process.env.SKIP_SYNC_BUILD);
const children = new Set();
let shuttingDown = false;

main().catch((error) => {
  console.error(`\n[dev] ${error instanceof Error ? error.message : String(error)}`);
  shutdown(1);
});

async function main() {
  if (syncMode !== "local" && syncMode !== "prod" && !options.syncUrl) {
    throw new Error(`--sync must be "local" or "prod" unless --sync-url is provided.`);
  }
  if (!["local", "global", "off"].includes(claudeSkills)) {
    throw new Error(`--claude-skills must be "local", "global", or "off".`);
  }

  assertRepo("agent-crm-app", appRepo);
  if (syncMode === "local") assertRepo("agent-crm-sync-engine", syncRepo);
  warnRepoBranch("agent-crm-app", appRepo);
  if (syncMode === "local") warnRepoBranch("agent-crm-sync-engine", syncRepo);

  const devBin = await writeLocalAcrmWrapper();
  const appEnv = {
    ...process.env,
    PATH: `${devBin}${delimiter}${process.env.PATH ?? ""}`,
    AGENT_CRM_SYNC_ENGINE_URL: syncUrl,
    ...(claudeSkills === "local" ? { CLAUDE_CONFIG_DIR: DEV_CLAUDE_CONFIG_DIR } : {}),
  };

  console.log(`[dev] agent-crm repo: ${AGENT_CRM_REPO}`);
  console.log(`[dev] app repo:       ${appRepo}`);
  console.log(`[dev] sync mode:      ${options.syncUrl ? "custom" : syncMode}`);
  console.log(`[dev] sync url:       ${syncUrl}`);
  console.log(`[dev] local acrm:     ${join(devBin, "acrm")}`);
  if (claudeSkills === "local") {
    console.log(`[dev] Claude config:  ${DEV_CLAUDE_CONFIG_DIR}`);
  } else if (claudeSkills === "global") {
    console.log("[dev] Claude config:  default ~/.claude");
  } else {
    console.log("[dev] Claude skills:  disabled");
  }

  if (claudeSkills === "local") {
    stageLocalClaudeSkills();
  }

  if (skills && skills !== "none") {
    await installLocalBundledSkills(skills, appEnv);
  }

  if (syncMode === "local") await startLocalSyncEngine();

  console.log("[dev] launching Electron app...");
  spawnPrefixed("app", "npm", ["run", "dev"], {
    cwd: appRepo,
    env: appEnv,
  });
}

async function installLocalBundledSkills(agents, env) {
  if (!agents || agents === "none") return;
  await runCommand("install local bundled skills", join(DEV_BIN_DIR, "acrm"), [
    "skills",
    "install",
    "--agents",
    agents,
  ], {
    cwd: AGENT_CRM_REPO,
    env,
  });
}

function stageLocalClaudeSkills() {
  seedClaudeConfig();
  const sourceDir = join(AGENT_CRM_REPO, "packages", "cli", "skills");
  const targetRoot = join(DEV_CLAUDE_CONFIG_DIR, "skills");
  rmSync(targetRoot, { recursive: true, force: true });
  mkdirSync(targetRoot, { recursive: true });

  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const sourcePath = join(sourceDir, entry.name);
    const skillName = skillNameFromMarkdown(sourcePath) ?? entry.name.replace(/\.md$/, "");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(skillName)) {
      throw new Error(`Unsafe skill name "${skillName}" in ${sourcePath}`);
    }
    const targetDir = join(targetRoot, skillName);
    mkdirSync(targetDir, { recursive: true });
    copyFileSync(sourcePath, join(targetDir, "SKILL.md"));
  }

  console.log(`[dev] staged local Claude Code skills in ${targetRoot}`);
}

function seedClaudeConfig() {
  mkdirSync(DEV_CLAUDE_CONFIG_DIR, { recursive: true });
  for (const entry of ["settings.json", "settings.local.json"]) {
    copyIfExists(join(USER_CLAUDE_CONFIG_DIR, entry), join(DEV_CLAUDE_CONFIG_DIR, entry));
  }
  copyDirIfExists(join(USER_CLAUDE_CONFIG_DIR, "commands"), join(DEV_CLAUDE_CONFIG_DIR, "commands"));
}

function copyIfExists(source, target) {
  if (!existsSync(source)) return;
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

function copyDirIfExists(source, target) {
  if (!existsSync(source)) return;
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
}

function skillNameFromMarkdown(filePath) {
  const text = readFileSync(filePath, "utf8");
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const nameLine = match[1].split(/\r?\n/).find((line) => line.startsWith("name:"));
  const name = nameLine?.slice("name:".length).trim();
  return name || null;
}

/*
  Local sync setup is intentionally below the app launch path: the sync engine
  can be swapped out with SYNC=prod while keeping local app + local CLI/skills.
*/
async function startLocalSyncEngine() {
  const syncEnv = {
    ...process.env,
    ...readDotenv(join(syncRepo, ".env")),
    PORT: syncPort,
    BASE_API_URL: syncUrl,
  };

  await clearPort(syncPort);

  if (!skipSyncBuild) {
    await runCommand("build sync engine", "npm", ["run", "build"], {
      cwd: syncRepo,
      env: syncEnv,
    });
  }

  const syncChild = spawnPrefixed("sync", "npm", ["start"], {
    cwd: syncRepo,
    env: syncEnv,
  });
  await waitForHttp(syncUrl, syncChild);
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!match) throw new Error(`Unknown argument: ${arg}`);
    const key = camelCase(match[1]);
    const value = match[2] ?? args[index + 1];
    if (match[2] === undefined && (value == null || value.startsWith("--"))) {
      if (key === "skipSyncBuild") {
        parsed[key] = true;
        continue;
      }
      throw new Error(`Missing value for ${arg}`);
    }
    parsed[key] = value;
    if (match[2] === undefined) index++;
  }
  return parsed;
}

function camelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function printHelp() {
  console.log(`
Usage:
  make app-dev
  make app-dev SYNC=prod
  make app-dev SYNC_URL=http://localhost:9000
  make app-dev CLAUDE_SKILLS=off
  npm run dev:app -- --sync local --port 8000

Options:
  --sync local|prod        local starts the sibling sync-engine; prod uses Render
  --sync-url <url>         custom sync-engine URL
  --port <port>            local sync-engine port (default: ${DEFAULT_PORT})
  --app-repo <path>        path to agent-crm-app (default: ../agent-crm-app)
  --sync-repo <path>       path to agent-crm-sync-engine (default: ../agent-crm-sync-engine)
  --claude-skills <mode>   local, global, or off (default: local)
  --skills <agents>        optional extra acrm skills install target, e.g. codex
  --skip-sync-build        start local sync-engine without rebuilding dist first

Notes:
  - The launcher does not switch branches or mutate global npm links.
  - The Electron app gets a temporary local acrm wrapper first in PATH.
  - By default, embedded Claude Code uses .agent-crm-dev/claude seeded from your Claude settings plus local skills.
  - Local sync-engine env is loaded from agent-crm-sync-engine/.env, then PORT and BASE_API_URL are overridden.
  - In SYNC=local mode, any process already listening on PORT is stopped before the sync-engine starts.
`);
}

function assertRepo(name, repoPath) {
  if (!existsSync(join(repoPath, "package.json"))) {
    throw new Error(`${name} repo not found at ${repoPath}`);
  }
  if (!existsSync(join(repoPath, "node_modules"))) {
    throw new Error(`${name} node_modules missing. Run npm install in ${repoPath}`);
  }
}

function warnRepoBranch(name, repoPath) {
  const branchResult = spawnSync("git", ["branch", "--show-current"], {
    cwd: repoPath,
    encoding: "utf8",
  });
  const branch = branchResult.stdout.trim();
  if (branchResult.status === 0 && branch && branch !== "main") {
    console.warn(`[dev] note: ${name} is on ${branch}, not main.`);
  }
  const statusResult = spawnSync("git", ["status", "--short", "--branch"], {
    cwd: repoPath,
    encoding: "utf8",
  });
  const statusLine = statusResult.stdout.split(/\r?\n/)[0] ?? "";
  if (statusResult.status === 0 && /\[.*behind/.test(statusLine)) {
    console.warn(`[dev] note: ${name} is behind its upstream branch.`);
  }
}

async function writeLocalAcrmWrapper() {
  const devBin = join(AGENT_CRM_REPO, ".agent-crm-dev", "bin");
  mkdirSync(devBin, { recursive: true });
  const wrapperPath = join(devBin, "acrm");
  writeFileSync(
    wrapperPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `exec npm --prefix ${shellQuote(AGENT_CRM_REPO)} run -s dev --workspace @agent-crm/cli -- "$@"`,
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(wrapperPath, 0o755);
  return devBin;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function readDotenv(filePath) {
  if (!existsSync(filePath)) return {};
  const env = {};
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals === -1) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function runCommand(label, command, args, options) {
  console.log(`[dev] ${label}: ${command} ${args.join(" ")}`);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`${label} failed (${signal ?? code})`));
      }
    });
  });
}

function spawnPrefixed(name, command, args, options) {
  console.log(`[dev] start ${name}: ${command} ${args.join(" ")}`);
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  child.stdout.on("data", (chunk) => writePrefixed(name, chunk));
  child.stderr.on("data", (chunk) => writePrefixed(name, chunk));
  child.on("exit", (code, signal) => {
    children.delete(child);
    if (!shuttingDown) {
      console.log(`[dev] ${name} exited (${signal ?? code})`);
      shutdown(code ?? 1);
    }
  });
  child.on("error", (error) => {
    children.delete(child);
    if (!shuttingDown) {
      console.error(`[dev] ${name} failed: ${error.message}`);
      shutdown(1);
    }
  });
  return child;
}

function writePrefixed(name, chunk) {
  for (const line of String(chunk).split(/\r?\n/)) {
    if (line.length > 0) process.stdout.write(`[${name}] ${line}\n`);
  }
}

async function waitForHttp(url, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`sync engine exited before ${url} became reachable`);
    }
    try {
      await fetch(url, { method: "GET" });
      console.log(`[dev] sync engine reachable at ${url}`);
      return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
  }
  throw new Error(`timed out waiting for sync engine at ${url}`);
}

async function clearPort(port) {
  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber <= 0) {
    throw new Error(`PORT must be a positive integer, got "${port}".`);
  }

  const pids = listenerPidsForPort(portNumber);
  if (pids.length === 0) return;

  console.log(`[dev] clearing port ${portNumber}: stopping ${pids.join(", ")}`);
  for (const pid of pids) killPid(pid, "SIGTERM");
  if (await waitForPortFree(portNumber, 3_000)) return;

  const remaining = listenerPidsForPort(portNumber);
  if (remaining.length === 0) return;
  console.warn(`[dev] clearing port ${portNumber}: force-stopping ${remaining.join(", ")}`);
  for (const pid of remaining) killPid(pid, "SIGKILL");
  if (!(await waitForPortFree(portNumber, 1_000))) {
    throw new Error(`port ${portNumber} is still in use after stopping existing listeners.`);
  }
}

function listenerPidsForPort(port) {
  const result = spawnSync("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(`failed to inspect port ${port}: ${result.error.message}`);
  }
  if (result.status !== 0 && !result.stdout.trim()) return [];
  return [...new Set(
    result.stdout
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
  )];
}

function killPid(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function waitForPortFree(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (listenerPidsForPort(port).length === 0) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  return listenerPidsForPort(port).length === 0;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), children.size > 0 ? 500 : 0).unref();
}

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));
