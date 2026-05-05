#!/usr/bin/env node
import { Command } from "commander";
import { registerInit } from "../commands/init.js";
import { registerExecute } from "../commands/execute.js";
import { registerImport } from "../commands/import.js";
import { fail } from "../output/json.js";

const program = new Command();

program
  .name("acrm")
  .description("Headless CRM for claude code — versioned, queryable, scriptable")
  .version("0.0.1")
  .option("-w, --workspace <path>", "path to .acrm directory (default: walk up from cwd)")
  .option("--json", "force JSON output (default when stdout is not a TTY)");

registerInit(program);
registerImport(program);
registerExecute(program);

program.parseAsync(process.argv).catch((err) => {
  fail(err instanceof Error ? err.message : String(err), "ERR_UNHANDLED");
  process.exit(1);
});
