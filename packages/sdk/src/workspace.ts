import { existsSync } from "node:fs";
import { openLix, type Lix } from "@lix-js/sdk";
import { createBetterSqlite3Backend } from "@lix-js/sdk/sqlite";
import { AcrmError, ERR } from "./lib/errors.js";

// Opaque handle wrapping a Lix. Owns the connection lifecycle. Callers that
// take a Workspace should not close it — only the code that opened it
// should. Path resolution (cwd walk-up, --workspace flag, extension
// inference) is a CLI concern and lives in @agent-crm/cli — Workspace.open
// and Workspace.create expect an absolute path.
export class Workspace {
  readonly lix: Lix;

  private constructor(lix: Lix) {
    this.lix = lix;
  }

  static async open(absolutePath: string): Promise<Workspace> {
    const lix = await openLix({
      backend: createBetterSqlite3Backend({ path: absolutePath }),
    });
    return new Workspace(lix);
  }

  static async create(absolutePath: string): Promise<Workspace> {
    if (existsSync(absolutePath)) {
      throw new AcrmError(
        `.acrm file already exists at ${absolutePath}`,
        ERR.WORKSPACE_EXISTS,
      );
    }
    return Workspace.open(absolutePath);
  }

  async close(): Promise<void> {
    await this.lix.close();
  }
}
