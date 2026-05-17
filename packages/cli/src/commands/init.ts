import path from "node:path";
import type { Command } from "commander";
import { AcrmError, ERR, createWorkspace } from "@agent-crm/sdk";
import { fail, isJson, ok, setJsonMode } from "../output/json.js";

export function registerInit(program: Command): void {
  program
    .command("init <name>")
    .description("create a new .acrm file in the current directory (e.g. `acrm init cluster.acrm`)")
    .action(async (name: string) => {
      const root = program.opts() as { json?: boolean };
      setJsonMode(root.json);
      try {
        const workspacePath = path.resolve(
          name.endsWith(".acrm") ? name : name + ".acrm",
        );
        const { workspace, workspaceId } = await createWorkspace(workspacePath);
        try {
          ok({
            initialized: true,
            workspace_id: workspaceId,
            workspace_path: workspacePath,
          });
          if (!isJson()) {
            const bold = process.env.NO_COLOR ? "" : "\x1b[1m";
            const reset = process.env.NO_COLOR ? "" : "\x1b[0m";
            process.stdout.write(
              `\nCreated ${workspacePath}\nNext steps:\n  ${bold}acrm import csv <path>${reset}     load your leads\n  ${bold}/setup-transcripts${reset}         connect a transcript provider to enable /post-call (optional)\n`,
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
