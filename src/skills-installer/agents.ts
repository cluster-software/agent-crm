import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AgentName = "claude-code" | "codex" | "cursor";

export interface Agent {
  name: AgentName;
  displayName: string;
  globalDir(): string;
  detect(): boolean;
}

// Per-agent install layout. Mirrors the conventions used by vercel-labs/skills
// (see https://github.com/vercel-labs/skills) for the agents we currently
// support. Adding a new agent = one entry here. Each agent reads from its
// `globalDir()` on session start and registers any SKILL.md it finds.
export const AGENTS: Record<AgentName, Agent> = {
  "claude-code": {
    name: "claude-code",
    displayName: "Claude Code",
    globalDir: () =>
      process.env.CLAUDE_CONFIG_DIR
        ? join(process.env.CLAUDE_CONFIG_DIR, "skills")
        : join(homedir(), ".claude", "skills"),
    detect: () => existsSync(join(homedir(), ".claude")),
  },
  codex: {
    name: "codex",
    displayName: "Codex",
    globalDir: () =>
      join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "skills"),
    detect: () =>
      existsSync(join(homedir(), ".codex")) || existsSync("/etc/codex"),
  },
  cursor: {
    name: "cursor",
    displayName: "Cursor",
    globalDir: () => join(homedir(), ".cursor", "skills"),
    detect: () => existsSync(join(homedir(), ".cursor")),
  },
};

export function detectInstalledAgents(): AgentName[] {
  return (Object.values(AGENTS) as Agent[])
    .filter((a) => a.detect())
    .map((a) => a.name);
}
