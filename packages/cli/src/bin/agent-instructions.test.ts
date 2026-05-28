import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import { AGENT_WORKSPACE_INSTRUCTIONS } from "../../../sdk/src/agent-instructions.js";
import { createAcrmProgram } from "./acrm.js";

function collectCommandPaths(command: Command, prefix: string[] = []): string[] {
  const paths: string[] = [];
  for (const child of command.commands) {
    const path = [...prefix, child.name()].join(" ");
    paths.push(path);
    paths.push(...collectCommandPaths(child, [...prefix, child.name()]));
  }
  return paths;
}

function isProviderAuthCommand(path: string): boolean {
  return path.startsWith("auth ");
}

describe("agent workspace instructions", () => {
  it("cover every public CLI command path that should be agent-visible", () => {
    const commandPaths = collectCommandPaths(createAcrmProgram()).filter(
      (path) => path !== "help" && !isProviderAuthCommand(path),
    );
    const covered = new Set<string>(AGENT_WORKSPACE_INSTRUCTIONS.coveredCommands);

    expect(commandPaths.filter((path) => !covered.has(path))).toEqual([]);
  });

  it("keep command coverage and the managed block in the same SDK export", () => {
    expect(AGENT_WORKSPACE_INSTRUCTIONS.block).toContain(
      AGENT_WORKSPACE_INSTRUCTIONS.startMarker,
    );
    expect(AGENT_WORKSPACE_INSTRUCTIONS.block).toContain(
      AGENT_WORKSPACE_INSTRUCTIONS.endMarker,
    );
    expect(AGENT_WORKSPACE_INSTRUCTIONS.coveredCommands).toContain("execute");
    expect(AGENT_WORKSPACE_INSTRUCTIONS.block).toContain(
      "Use the installed `acrm` directly",
    );
    expect(AGENT_WORKSPACE_INSTRUCTIONS.block).not.toContain("acrm --version");
    expect(AGENT_WORKSPACE_INSTRUCTIONS.block).not.toContain(
      "npm view @agent-crm/cli version",
    );
    expect(AGENT_WORKSPACE_INSTRUCTIONS.block).not.toContain(
      "npm install -g @agent-crm/cli@latest",
    );
  });
});
