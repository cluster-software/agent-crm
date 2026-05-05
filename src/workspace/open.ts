import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { openLix, type Lix } from "@lix-js/sdk";
import { createBetterSqlite3Backend } from "@lix-js/sdk/sqlite";
import { AcrmError, ERR } from "../lib/errors.js";

const FILE_EXT = ".acrm";
const FILE_NAME = "workspace.lix";

export function findWorkspace(start: string = process.cwd()): string | null {
  let cur = path.resolve(start);
  while (true) {
    let entries: string[] = [];
    try {
      entries = readdirSync(cur);
    } catch {
      // unreadable dir; skip
    }
    const matches = entries.filter(
      (name) =>
        name.endsWith(FILE_EXT) && existsSync(path.join(cur, name, FILE_NAME)),
    );
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

export function workspaceFilePath(dir: string): string {
  return path.join(dir, FILE_NAME);
}

export async function openWorkspace(opts?: { workspace?: string; create?: boolean }): Promise<Lix> {
  let dir = opts?.workspace;
  if (dir) {
    dir = path.resolve(dir);
    if (!dir.endsWith(FILE_EXT)) dir = dir + FILE_EXT;
  } else {
    const found = findWorkspace();
    if (!found) {
      throw new AcrmError(
        "no .acrm file found (run `acrm init <name>.acrm` to create one)",
        ERR.NO_WORKSPACE,
      );
    }
    dir = found;
  }
  if (opts?.create) {
    if (existsSync(workspaceFilePath(dir))) {
      throw new AcrmError(`.acrm file already exists at ${dir}`, ERR.WORKSPACE_EXISTS);
    }
    mkdirSync(dir, { recursive: true });
  }
  const lix = await openLix({
    backend: createBetterSqlite3Backend({ path: workspaceFilePath(dir) }),
  });
  return lix;
}
