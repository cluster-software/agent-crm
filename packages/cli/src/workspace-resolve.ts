import { statSync, readdirSync } from "node:fs";
import path from "node:path";
import { AcrmError, ERR } from "@agent-crm/sdk";

const FILE_EXT = ".acrm";

// Walk up from `start` looking for a .acrm file. Returns the absolute path,
// or null if none found. Throws if multiple are found in the same dir.
// CLI-only — the SDK works only with explicit absolute paths.
export function findWorkspace(start: string = process.cwd()): string | null {
  let cur = path.resolve(start);
  while (true) {
    let entries: string[] = [];
    try {
      entries = readdirSync(cur);
    } catch {
      // unreadable dir; skip
    }
    const matches = entries.filter((name) => {
      if (!name.endsWith(FILE_EXT)) return false;
      try {
        return statSync(path.join(cur, name)).isFile();
      } catch {
        return false;
      }
    });
    if (matches.length === 1) return path.join(cur, matches[0]!);
    if (matches.length > 1) {
      throw new AcrmError(
        `multiple .acrm files found in ${cur}: ${matches.join(", ")}. Use --workspace to pick one.`,
        ERR.NO_WORKSPACE,
      );
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

// Resolve a workspace path from a CLI --workspace flag value, or fall back
// to walking up from cwd. Returns an absolute path with the .acrm extension.
// Throws with the CLI's run-`acrm init` hint when nothing is found.
export function resolveWorkspacePath(workspace?: string): string {
  if (workspace) {
    let file = path.resolve(workspace);
    if (!file.endsWith(FILE_EXT)) file = file + FILE_EXT;
    return file;
  }
  const found = findWorkspace();
  if (!found) {
    throw new AcrmError(
      "no .acrm file found (run `acrm init <name>.acrm` to create one)",
      ERR.NO_WORKSPACE,
    );
  }
  return found;
}
