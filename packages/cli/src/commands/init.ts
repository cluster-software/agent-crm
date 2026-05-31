import type { Command } from "commander";
import {
  AcrmError,
  ERR,
  Workspace,
  ensureWorkspaceIdentity,
} from "@agent-crm/sdk";
import { fail, isJson, ok, setJsonMode } from "../output/json.js";
import { resolveDatabaseConfig } from "../workspace-resolve.js";

export function registerInit(program: Command): void {
  program
    .command("init [databaseUrl]")
    .description("initialize the Agent CRM EAV schema in a Postgres-compatible database")
    .action(async (databaseUrl: string | undefined) => {
      const root = program.opts() as { json?: boolean; workspace?: string };
      setJsonMode(root.json);
      try {
        const workspace = await Workspace.create(
          resolveDatabaseConfig(databaseUrl ?? root.workspace),
        );
        try {
          const workspaceId = await ensureWorkspaceIdentity(workspace);
          ok({
            initialized: true,
            workspace_id: workspaceId,
          });
          if (!isJson()) {
            const bold = process.env.NO_COLOR ? "" : "\x1b[1m";
            const reset = process.env.NO_COLOR ? "" : "\x1b[0m";
            process.stdout.write(
              `\nInitialized Agent CRM schema\nNext steps:\n  ${bold}acrm import csv <path>${reset}          load your leads\n  ${bold}acrm connect granola${reset}            connect Granola transcripts (optional)\n`,
            );
          }
        } finally {
          await workspace.close();
        }
      } catch (e) {
        if (e instanceof AcrmError) fail(e.message, e.code, e.hint);
        else fail(e instanceof Error ? e.message : String(e), ERR.INIT);
        process.exit(1);
      }
    });
}
