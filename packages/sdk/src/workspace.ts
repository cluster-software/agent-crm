import type { AcrmDatabase } from "./db/types.js";
import { connectDatabase } from "./db/providers/registry.js";
import type { DatabasePoolOptions, DatabaseProviderName } from "./db/providers/types.js";
import { ensureWorkspaceIdentity } from "./workspace/identity.js";
import { initializeWorkspace } from "./workspace/initialize.js";

export type WorkspaceOpenOptions = {
  databaseUrl?: string;
  provider?: DatabaseProviderName | string;
  pool?: DatabasePoolOptions;
  db?: AcrmDatabase;
  closeDatabaseOnClose?: boolean;
};

// Opaque handle wrapping the Agent CRM database connection. Cloud workspaces use
// pluggable Postgres-compatible providers; callers that inject a db handle own
// its lifecycle unless closeDatabaseOnClose is explicitly true.
export class Workspace {
  readonly db: AcrmDatabase;
  private closed = false;

  constructor(
    db: AcrmDatabase,
    private readonly closeDatabaseOnClose: boolean,
  ) {
    this.db = db;
  }

  static async open(input: string | WorkspaceOpenOptions = {}): Promise<Workspace> {
    const workspace = await openWorkspace(input);
    try {
      await initializeWorkspace(workspace.db);
      await ensureWorkspaceIdentity(workspace);
      return workspace;
    } catch (error) {
      await workspace.close().catch(() => undefined);
      throw error;
    }
  }

  static async create(input: string | WorkspaceOpenOptions = {}): Promise<Workspace> {
    return await Workspace.open(input);
  }

  static fromDatabase(
    db: AcrmDatabase,
    opts: { closeDatabaseOnClose?: boolean } = {},
  ): Workspace {
    return new Workspace(db, opts.closeDatabaseOnClose ?? false);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.closeDatabaseOnClose) {
      await this.db.close();
    }
  }
}

async function openWorkspace(
  input: string | WorkspaceOpenOptions,
): Promise<Workspace> {
  const options = typeof input === "string" ? { databaseUrl: input } : input;
  if (options.db) {
    return new Workspace(options.db, options.closeDatabaseOnClose ?? false);
  }
  return new Workspace(connectDatabase(options), true);
}
