// npm postinstall entry point. Invoked by scripts/postinstall.cjs.
//
// Hard rule: this script must never fail npm install. All errors are caught
// and logged to stderr; the process always exits 0.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  syncSkills,
  AGENTS,
  type AgentName,
} from "../skills-installer/index.js";

// Resolves to <pkg>/skills/ for every install topology — global, local, npx,
// and `npm link` — because import.meta.url tracks the actual location of
// this file on disk.
const here = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(here, "..", "..", "skills");

const pkg = createRequire(import.meta.url)("../../package.json") as {
  version: string;
};

async function main(): Promise<void> {
  if (process.env.ACRM_SKIP_SKILLS) {
    process.stderr.write(
      "acrm: ACRM_SKIP_SKILLS set — skipping skills install.\n",
    );
    return;
  }

  // sudo on Unix: postinstall would write to root's HOME, not the user's.
  // Skip and tell the user to run the manual command as themselves.
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === 0 && process.env.SUDO_USER) {
    process.stderr.write(
      "acrm: detected sudo install — skipping skills install. " +
        "Run `acrm skills install` as your user.\n",
    );
    return;
  }

  const r = await syncSkills({
    bundledSkillsDir: SKILLS_DIR,
    acrmVersion: pkg.version,
  });
  const targets = r.targetAgents
    .map((a: AgentName) => AGENTS[a].displayName)
    .join(", ");
  if (r.installed.length || r.updated.length || r.removed.length) {
    let line = `acrm: skills synced for ${targets}`;
    if (r.installed.length) line += `, installed: ${r.installed.join(", ")}`;
    if (r.updated.length) line += `, updated: ${r.updated.join(", ")}`;
    if (r.removed.length) line += `, removed: ${r.removed.join(", ")}`;
    process.stderr.write(line + "\n");
  } else if (!r.targetAgents.length) {
    process.stderr.write(
      "acrm: no supported agents detected (claude-code, codex, cursor) — " +
        "skills not installed. Run `acrm skills install` after installing an agent.\n",
    );
  }
}

main().catch((err) => {
  process.stderr.write(
    `acrm: skills install failed (continuing) — ${
      err instanceof Error ? err.message : String(err)
    }\n` + "Run `acrm skills install` manually after install completes.\n",
  );
});
