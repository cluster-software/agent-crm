import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { openLix, type Lix } from "@lix-js/sdk";
import { createBetterSqlite3Backend } from "@lix-js/sdk/sqlite";
import Database from "better-sqlite3";
import { AcrmError, ERR } from "./lib/errors.js";
import { ensureWorkspaceIdentity } from "./workspace/identity.js";
import { initializeWorkspace } from "./workspace/initialize.js";

const SQLITE_BUSY_TIMEOUT_MS = 30_000;

// Opaque handle wrapping a Lix. Workspaces created by open/create own the
// connection lifecycle; handles from fromLix() borrow it by default. Callers
// that receive a Workspace should not close it — only the code that opened or
// wrapped it should. Path resolution (cwd walk-up, --workspace flag, extension
// inference) is a CLI concern and lives in @agent-crm/cli — Workspace.open and
// Workspace.create expect an absolute path.
export class Workspace {
  readonly lix: Lix;
  private closed = false;

  private constructor(
    lix: Lix,
    private readonly closeLixOnClose: boolean,
  ) {
    this.lix = lix;
  }

  static async open(absolutePath: string): Promise<Workspace> {
    assertAbsolutePath(absolutePath);
    if (!existsSync(absolutePath)) {
      throw new AcrmError(
        `.acrm file not found at ${absolutePath}`,
        ERR.NO_WORKSPACE,
      );
    }
    const workspace = new Workspace(await openWorkspaceLix(absolutePath), true);
    await ensureWorkspaceIdentity(workspace);
    return workspace;
  }

  // Wrap an existing Lix in a Workspace handle without taking ownership by
  // default. Intended for tests and callers that already own the Lix lifecycle.
  static fromLix(
    lix: Lix,
    opts: { closeLixOnClose?: boolean } = {},
  ): Workspace {
    return new Workspace(lix, opts.closeLixOnClose ?? false);
  }

  static async create(absolutePath: string): Promise<Workspace> {
    assertAbsolutePath(absolutePath);
    if (existsSync(absolutePath)) {
      throw new AcrmError(
        `.acrm file already exists at ${absolutePath}`,
        ERR.WORKSPACE_EXISTS,
      );
    }
    const lix = await openWorkspaceLix(absolutePath);
    try {
      await initializeWorkspace(lix);
      return new Workspace(lix, true);
    } catch (e) {
      await lix.close().catch(() => undefined);
      await rm(absolutePath, { force: true }).catch(() => undefined);
      throw e;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.closeLixOnClose) {
      await this.lix.close();
    }
  }
}

async function openWorkspaceLix(absolutePath: string): Promise<Lix> {
  configureWorkspaceSqliteFile(absolutePath);
  return openLix({
    backend: createBetterSqlite3Backend({
      path: absolutePath,
      databaseOptions: {
        timeout: SQLITE_BUSY_TIMEOUT_MS,
      },
    }),
  });
}

function assertAbsolutePath(workspacePath: string): void {
  if (isAbsolute(workspacePath)) return;
  throw new AcrmError(
    `workspace path must be absolute: ${workspacePath}`,
    ERR.INVALID_INPUT,
  );
}

function configureWorkspaceSqliteFile(absolutePath: string): void {
  const db = new Database(absolutePath, {
    timeout: SQLITE_BUSY_TIMEOUT_MS,
  });
  try {
    db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    db.pragma("journal_mode = WAL");
  } finally {
    db.close();
  }
}
