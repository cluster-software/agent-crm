import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import {
  syncSkills,
  removeAllSkills,
  AGENTS,
  readLockfile,
  type AgentName,
} from "../skills-installer/index.js";
import { fail, isJson, ok, setJsonMode } from "../output/json.js";
import { ERR } from "../lib/errors.js";

// Resolves to <pkg>/skills/ regardless of install topology.
const here = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(here, "..", "..", "skills");

const pkg = createRequire(import.meta.url)("../../package.json") as {
  version: string;
};

const ALL_AGENTS = Object.keys(AGENTS) as AgentName[];

function parseAgentList(value: string | undefined): AgentName[] | undefined {
  if (!value) return undefined;
  const parts = value
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const out: AgentName[] = [];
  for (const p of parts) {
    if ((ALL_AGENTS as string[]).includes(p)) out.push(p as AgentName);
    else
      throw new Error(
        `unknown agent: ${p} (supported: ${ALL_AGENTS.join(", ")})`,
      );
  }
  return out;
}

export function registerSkills(program: Command): void {
  const skills = program
    .command("skills")
    .description(
      "install bundled acrm skills (SKILL.md files) into your installed AI agents (Claude Code, Codex, Cursor). Normally runs automatically via npm postinstall; use these subcommands to re-run or inspect.",
    );

  skills
    .command("install")
    .description(
      "install acrm skills into detected agents (or those passed via --agents). Idempotent — re-runs only update changed skills.",
    )
    .option(
      "-a, --agents <list>",
      `comma-separated list of agents (default: auto-detect). Supported: ${ALL_AGENTS.join(", ")}`,
    )
    .action(async (opts: { agents?: string }) => {
      const root = program.opts() as { json?: boolean };
      setJsonMode(root.json);
      try {
        const agents = parseAgentList(opts.agents);
        const r = await syncSkills({
          bundledSkillsDir: SKILLS_DIR,
          acrmVersion: pkg.version,
          agents,
        });
        ok({
          target_agents: r.targetAgents,
          skipped_agents: r.skippedAgents,
          installed: r.installed,
          updated: r.updated,
          removed: r.removed,
        });
        if (!isJson()) {
          const names = r.targetAgents
            .map((a) => AGENTS[a].displayName)
            .join(", ");
          process.stdout.write(
            `Targets:  ${names || "(none detected — pass --agents to force)"}\n`,
          );
          if (r.installed.length)
            process.stdout.write(`Installed: ${r.installed.join(", ")}\n`);
          if (r.updated.length)
            process.stdout.write(`Updated:   ${r.updated.join(", ")}\n`);
          if (r.removed.length)
            process.stdout.write(`Removed:   ${r.removed.join(", ")}\n`);
          if (r.skippedAgents.length) {
            process.stdout.write(
              `Skipped:   ${r.skippedAgents.join(", ")} (not detected — pass --agents to force)\n`,
            );
          }
        }
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e), ERR.SKILLS);
        process.exit(1);
      }
    });

  skills
    .command("list")
    .description("show installed acrm skills and where they live on disk")
    .action(async () => {
      const root = program.opts() as { json?: boolean };
      setJsonMode(root.json);
      try {
        const lock = await readLockfile();
        const skillsList = Object.entries(lock.skills).map(
          ([name, entry]) => ({
            name,
            installed_at: entry.installedAt,
            agents: Object.fromEntries(
              Object.entries(entry.agents).map(([a, info]) => [a, info?.path]),
            ),
          }),
        );
        ok({
          acrm_version: lock.acrmVersion,
          count: skillsList.length,
          skills: skillsList,
        });
        if (!isJson()) {
          if (!skillsList.length) {
            process.stdout.write(
              "No skills installed. Run `acrm skills install`.\n",
            );
            return;
          }
          for (const s of skillsList) {
            const agentNames = Object.keys(s.agents).join(", ");
            process.stdout.write(`${s.name}  →  ${agentNames}\n`);
          }
        }
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e), ERR.SKILLS);
        process.exit(1);
      }
    });

  skills
    .command("remove")
    .description("remove every acrm-installed skill from every agent")
    .action(async () => {
      const root = program.opts() as { json?: boolean };
      setJsonMode(root.json);
      try {
        const removed = await removeAllSkills();
        ok({ removed });
        if (!isJson()) {
          process.stdout.write(
            removed.length
              ? `Removed: ${removed.join(", ")}\n`
              : "Nothing to remove.\n",
          );
        }
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e), ERR.SKILLS);
        process.exit(1);
      }
    });
}
