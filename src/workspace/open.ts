import { existsSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import { openLix, type Lix } from "@lix-js/sdk";
import { createBetterSqlite3Backend } from "@lix-js/sdk/sqlite";
import { AcrmError, ERR } from "../lib/errors.js";

const FILE_EXT = ".acrm";

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

export async function openWorkspace(opts?: { workspace?: string; create?: boolean }): Promise<Lix> {
  let file = opts?.workspace;
  if (file) {
    file = path.resolve(file);
    if (!file.endsWith(FILE_EXT)) file = file + FILE_EXT;
  } else {
    const found = findWorkspace();
    if (!found) {
      throw new AcrmError(
        "no .acrm file found (run `acrm init <name>.acrm` to create one)",
        ERR.NO_WORKSPACE,
      );
    }
    file = found;
  }
  if (opts?.create && existsSync(file)) {
    throw new AcrmError(`.acrm file already exists at ${file}`, ERR.WORKSPACE_EXISTS);
  }
  const lix = await openLix({
    backend: createBetterSqlite3Backend({ path: file }),
  });
  return lix;
}
