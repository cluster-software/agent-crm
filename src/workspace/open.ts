import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { openLix, type Lix } from "@lix-js/sdk";
import { createBetterSqlite3Backend } from "@lix-js/sdk/sqlite";
import { AcrmError, ERR } from "../lib/errors.js";

const DIR_NAME = ".acrm";
const FILE_NAME = "workspace.lix";

export function findWorkspace(start: string = process.cwd()): string | null {
  let cur = path.resolve(start);
  while (true) {
    const candidate = path.join(cur, DIR_NAME);
    if (existsSync(path.join(candidate, FILE_NAME))) return candidate;
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
    if (!dir.endsWith(DIR_NAME)) dir = path.join(dir, DIR_NAME);
  } else {
    const found = findWorkspace();
    if (!found) {
      if (!opts?.create) {
        throw new AcrmError(
          "no .acrm workspace found (run `acrm init` to create one)",
          ERR.NO_WORKSPACE,
        );
      }
      dir = path.join(process.cwd(), DIR_NAME);
    } else {
      dir = found;
    }
  }
  if (opts?.create) {
    if (existsSync(workspaceFilePath(dir))) {
      throw new AcrmError(`workspace already exists at ${dir}`, ERR.WORKSPACE_EXISTS);
    }
    mkdirSync(dir, { recursive: true });
  }
  const lix = await openLix({
    backend: createBetterSqlite3Backend({ path: workspaceFilePath(dir) }),
  });
  return lix;
}

export const WORKSPACE_DIR_NAME = DIR_NAME;
