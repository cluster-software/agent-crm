import type { Command } from "commander";
import type { LixRuntimeValue } from "@lix-js/sdk";
import { openWorkspace } from "../workspace/open.js";
import { exec } from "../db/execute.js";
import { fail, ok, setJsonMode } from "../output/json.js";
import { AcrmError } from "../lib/errors.js";

export function registerExecute(program: Command): void {
  program
    .command("execute <sql> [params]")
    .description("run a SQL query or mutation against the workspace; params is a JSON array")
    .action(async (sql: string, paramsJson: string | undefined) => {
      const root = program.opts() as { json?: boolean; workspace?: string };
      setJsonMode(root.json);
      try {
        let params: LixRuntimeValue[] = [];
        if (paramsJson) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(paramsJson);
          } catch {
            throw new AcrmError(
              `params must be a JSON array, got: ${paramsJson}`,
              "ERR_INVALID_INPUT",
            );
          }
          if (!Array.isArray(parsed)) {
            throw new AcrmError("params must be a JSON array", "ERR_INVALID_INPUT");
          }
          params = parsed as LixRuntimeValue[];
        }
        const lix = await openWorkspace({ workspace: root.workspace });
        try {
          const result = await exec(lix, sql, params);
          ok({ rows: result.rows, rows_affected: result.rowsAffected });
        } finally {
          await lix.close();
        }
      } catch (e) {
        if (e instanceof AcrmError) fail(e.message, e.code);
        else fail(e instanceof Error ? e.message : String(e), "ERR_EXECUTE");
        process.exit(1);
      }
    });
}
