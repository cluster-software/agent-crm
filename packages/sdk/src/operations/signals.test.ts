import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openLix, type Lix } from "@lix-js/sdk";
import { createBetterSqlite3Backend } from "@lix-js/sdk/sqlite";
import { describe, expect, it } from "vitest";
import { exec } from "../db/execute.js";
import { createRecord } from "./records.js";
import {
  loadSignalDefinitions,
  runSignals,
  type SignalRunner,
} from "./signals.js";
import { seedAttributes, seedObjects } from "../workspace/seeds.js";
import { registerAllSchemas } from "../workspace/schemas/index.js";
import { Workspace } from "../workspace.js";

async function openTestWorkspace(): Promise<Lix> {
  const lix = await openLix({
    backend: createBetterSqlite3Backend({ path: ":memory:" }),
  });
  await registerAllSchemas(lix);
  await seedObjects(lix);
  await seedAttributes(lix);
  return lix;
}

async function withSignalsDir(
  body: string,
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "acrm-signals-"));
  const dir = path.join(root, "signals");
  await mkdir(dir);
  await writeFile(path.join(dir, "hotel_contact_path.md"), body, "utf8");
  return {
    dir,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

const hotelSignal = `---
slug: hotel_contact_path
title: Hotel Contact Path
object: companies
---

\`\`\`json acrm-signal
{
  "outputs": [
    {
      "key": "operator_status",
      "attribute": "operator_status",
      "title": "Operator status",
      "type": "status",
      "options": ["owner_identified:Owner identified", "unclear:Unclear"]
    },
    {
      "key": "operator_name",
      "attribute": "operator_name",
      "title": "Operator name",
      "type": "text"
    }
  ]
}
\`\`\`

Search the hotel website imprint and local press for the operator.
`;

describe("signals", () => {
  it("parses a multi-output signal definition", async () => {
    const { dir, cleanup } = await withSignalsDir(hotelSignal);
    try {
      const definitions = await loadSignalDefinitions(dir);
      expect(definitions).toHaveLength(1);
      expect(definitions[0]?.slug).toBe("hotel_contact_path");
      expect(definitions[0]?.object_slug).toBe("companies");
      expect(definitions[0]?.outputs.map((output) => output.key)).toEqual([
        "operator_status",
        "operator_name",
      ]);
    } finally {
      await cleanup();
    }
  });

  it("syncs attributes, runs once, and stores per-field provenance", async () => {
    const lix = await openTestWorkspace();
    const { dir, cleanup } = await withSignalsDir(hotelSignal);
    try {
      const company = await createRecord(Workspace.fromLix(lix), {
        object_slug: "companies",
        fields: ["name=Hotel Felix", "domains=hotelfelix.example"],
      });
      let calls = 0;
      const runner: SignalRunner = async (prompt) => {
        calls++;
        expect(prompt).toContain("operator_status");
        expect(prompt).toContain("Hotel Felix");
        expect(prompt).toContain("Output must be raw JSON parseable by JSON.parse");
        expect(prompt).toContain("operator_name (text): value must be a non-empty JSON string.");
        expect(prompt).toContain("Use WebSearch to discover public sources and WebFetch to verify pages");
        expect(prompt).toContain("Never cite training data");
        return JSON.stringify({
          outputs: [
            {
              key: "operator_status",
              value: "owner_identified",
              confidence: "high",
              citations: [
                {
                  url: "https://hotelfelix.example/imprint",
                  title: "Imprint",
                },
              ],
              reasoning: "The imprint names Felix Hotels GmbH as the operator.",
            },
            {
              key: "operator_name",
              value: "Felix Hotels GmbH",
              confidence: "high",
              citations: [],
              reasoning: "The legal notice lists this entity.",
            },
          ],
        });
      };

      const result = await runSignals(Workspace.fromLix(lix), {
        signalsDir: dir,
        records: [{ object_slug: "companies", record_id: company.record_id }],
        mode: "missing",
        runner,
      });

      expect(calls).toBe(1);
      expect(result.values_written).toBe(2);
      expect(result.statuses).toEqual([
        {
          object_slug: "companies",
          record_id: company.record_id,
          signal_slug: "hotel_contact_path",
          status: "succeeded",
          values_written: 2,
        },
      ]);
      const values = await exec(
        lix,
        `SELECT attribute_slug, value_json, source, provenance_json
           FROM acrm_value
          WHERE object_slug = 'companies'
            AND record_id = $1
            AND attribute_slug IN ('operator_status', 'operator_name')
            AND active_until IS NULL
          ORDER BY attribute_slug`,
        [company.record_id],
      );
      expect(values.rows).toHaveLength(2);
      const byAttr = new Map(
        values.rows.map((row) => [row.attribute_slug as string, row]),
      );
      expect(JSON.parse(byAttr.get("operator_status")!.value_json as string)).toEqual({
        id: "owner_identified",
        title: "Owner identified",
      });
      const provenance = JSON.parse(
        byAttr.get("operator_name")!.provenance_json as string,
      ) as Record<string, unknown>;
      expect(byAttr.get("operator_name")!.source).toBe("signal:hotel_contact_path");
      expect(provenance.reasoning).toBe("The legal notice lists this entity.");
      expect(provenance.uncited).toBe(true);
    } finally {
      await cleanup();
      await lix.close();
    }
  });

  it("does not rerun missing-only signals when outputs already exist", async () => {
    const lix = await openTestWorkspace();
    const { dir, cleanup } = await withSignalsDir(hotelSignal);
    try {
      const company = await createRecord(Workspace.fromLix(lix), {
        object_slug: "companies",
        fields: ["name=Hotel Existing"],
      });
      const firstRunner: SignalRunner = async () =>
        JSON.stringify({
          outputs: [
            {
              key: "operator_status",
              value: "unclear",
              confidence: "low",
              citations: [],
              reasoning: "No non-obvious source was found.",
            },
            {
              key: "operator_name",
              value: "Unknown",
              confidence: "low",
              citations: [],
              reasoning: "No operator was named in public sources.",
            },
          ],
        });
      await runSignals(Workspace.fromLix(lix), {
        signalsDir: dir,
        records: [{ object_slug: "companies", record_id: company.record_id }],
        mode: "missing",
        runner: firstRunner,
      });

      const second = await runSignals(Workspace.fromLix(lix), {
        signalsDir: dir,
        records: [{ object_slug: "companies", record_id: company.record_id }],
        mode: "missing",
        runner: async () => {
          throw new Error("should not run");
        },
      });

      expect(second.runs_attempted).toBe(0);
      expect(second.skipped).toBe(1);
      expect(second.statuses).toEqual([
        {
          object_slug: "companies",
          record_id: company.record_id,
          signal_slug: "hotel_contact_path",
          status: "skipped",
        },
      ]);
    } finally {
      await cleanup();
      await lix.close();
    }
  });

  it("rejects signal outputs that target core CRM fields", async () => {
    const coreFieldSignal = `---
slug: bad_core_signal
title: Bad Core Signal
object: companies
---

\`\`\`json acrm-signal
{
  "outputs": [
    {
      "key": "company_name",
      "attribute": "name",
      "title": "Company name",
      "type": "text"
    }
  ]
}
\`\`\`

Find the company name.
`;
    const lix = await openTestWorkspace();
    const { dir, cleanup } = await withSignalsDir(coreFieldSignal);
    try {
      const company = await createRecord(Workspace.fromLix(lix), {
        object_slug: "companies",
        fields: ["name=Hotel Protected"],
      });
      await expect(
        runSignals(Workspace.fromLix(lix), {
          signalsDir: dir,
          records: [{ object_slug: "companies", record_id: company.record_id }],
          mode: "force",
          runner: async () => {
            throw new Error("should not run");
          },
        }),
      ).rejects.toThrow(/targets core field companies\.name/);
    } finally {
      await cleanup();
      await lix.close();
    }
  });

  it("records a failure when a runner returns an unknown output key", async () => {
    const lix = await openTestWorkspace();
    const { dir, cleanup } = await withSignalsDir(hotelSignal);
    try {
      const company = await createRecord(Workspace.fromLix(lix), {
        object_slug: "companies",
        fields: ["name=Hotel Bad Output"],
      });
      const result = await runSignals(Workspace.fromLix(lix), {
        signalsDir: dir,
        records: [{ object_slug: "companies", record_id: company.record_id }],
        mode: "force",
        runner: async () =>
          JSON.stringify({
            outputs: [
              {
                key: "not_declared",
                value: "oops",
                confidence: "low",
                citations: [],
                reasoning: "This key is not in the signal definition.",
              },
            ],
          }),
      });
      expect(result.runs_failed).toBe(1);
      expect(result.statuses[0]?.status).toBe("failed");
      expect(result.failures[0]?.message).toMatch(/unknown output key/);
    } finally {
      await cleanup();
      await lix.close();
    }
  });

  it("records a failure when a runner returns a value with the wrong declared type", async () => {
    const typedSignal = `---
slug: typed_signal
title: Typed Signal
object: companies
---

\`\`\`json acrm-signal
{
  "outputs": [
    {
      "key": "employee_count",
      "attribute": "employee_count",
      "title": "Employee count",
      "type": "number"
    }
  ]
}
\`\`\`

Find the number of employees.
`;
    const lix = await openTestWorkspace();
    const { dir, cleanup } = await withSignalsDir(typedSignal);
    try {
      const company = await createRecord(Workspace.fromLix(lix), {
        object_slug: "companies",
        fields: ["name=Hotel Wrong Type"],
      });
      const result = await runSignals(Workspace.fromLix(lix), {
        signalsDir: dir,
        records: [{ object_slug: "companies", record_id: company.record_id }],
        mode: "force",
        runner: async (prompt) => {
          expect(prompt).toContain("employee_count (number): value must be a finite JSON number");
          return JSON.stringify({
            outputs: [
              {
                key: "employee_count",
                value: "42",
                confidence: "high",
                citations: [],
                reasoning: "The source says there are 42 employees.",
              },
            ],
          });
        },
      });
      expect(result.runs_failed).toBe(1);
      expect(result.values_written).toBe(0);
      expect(result.failures[0]?.message).toMatch(/invalid number value/);
      expect(result.failures[0]?.stdout_excerpt).toContain("employee_count");
    } finally {
      await cleanup();
      await lix.close();
    }
  });

  it("allows web tools, attaches a JSON schema, and passes the configured Claude model", async () => {
    const lix = await openTestWorkspace();
    const { dir, cleanup } = await withSignalsDir(hotelSignal);
    const binDir = await mkdtemp(path.join(tmpdir(), "acrm-claude-bin-"));
    const argsPath = path.join(binDir, "args.json");
    const claudePath = path.join(binDir, "claude");
    const previousPath = process.env.PATH;
    const previousRunner = process.env.ACRM_SIGNAL_RUNNER;
    const previousSignalRunsModel = process.env.SIGNAL_RUNS_MODEL;
    const previousArgsPath = process.env.ACRM_TEST_CLAUDE_ARGS;
    try {
      await writeFile(
        claudePath,
        `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.ACRM_TEST_CLAUDE_ARGS, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "text", text: "Searching public hotel pages..." }] }
}));
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  structured_output: {
    outputs: [
      {
        key: "operator_status",
        value: "owner_identified",
        confidence: "high",
        citations: [{ url: "https://example.test/imprint", title: "Imprint" }],
        reasoning: "The fetched imprint identifies the operator."
      },
      {
        key: "operator_name",
        value: "Example Hotels GmbH",
        confidence: "high",
        citations: [{ url: "https://example.test/imprint", title: "Imprint" }],
        reasoning: "The fetched imprint names the operating entity."
      }
    ]
  }
}));
`,
        "utf8",
      );
      await chmod(claudePath, 0o755);
      process.env.PATH = `${binDir}:${previousPath ?? ""}`;
      process.env.ACRM_TEST_CLAUDE_ARGS = argsPath;
      delete process.env.ACRM_SIGNAL_RUNNER;
      delete process.env.SIGNAL_RUNS_MODEL;

      const company = await createRecord(Workspace.fromLix(lix), {
        object_slug: "companies",
        fields: ["name=Hotel Default Runner"],
      });
      const result = await runSignals(Workspace.fromLix(lix), {
        signalsDir: dir,
        records: [{ object_slug: "companies", record_id: company.record_id }],
        mode: "force",
      });
      expect(result.runs_succeeded).toBe(1);
      const args = JSON.parse(await readFile(argsPath, "utf8")) as string[];
      expect(args).toContain("--output-format");
      expect(args).toContain("stream-json");
      expect(args).toContain("--verbose");
      expect(args).toContain("--model");
      expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
      expect(args).toContain("--tools");
      expect(args).toContain("WebSearch,WebFetch");
      expect(args).toContain("--allowedTools");
      expect(args).toContain("--json-schema");
      const schema = JSON.parse(args[args.indexOf("--json-schema") + 1]!) as Record<string, unknown>;
      expect(JSON.stringify(schema)).toContain("operator_status");

      process.env.SIGNAL_RUNS_MODEL = "opus";
      const overrideCompany = await createRecord(Workspace.fromLix(lix), {
        object_slug: "companies",
        fields: ["name=Hotel Model Override"],
      });
      const overrideResult = await runSignals(Workspace.fromLix(lix), {
        signalsDir: dir,
        records: [{ object_slug: "companies", record_id: overrideCompany.record_id }],
        mode: "force",
      });
      expect(overrideResult.runs_succeeded).toBe(1);
      const overrideArgs = JSON.parse(await readFile(argsPath, "utf8")) as string[];
      expect(overrideArgs[overrideArgs.indexOf("--model") + 1]).toBe("opus");
    } finally {
      process.env.PATH = previousPath;
      if (previousRunner === undefined) delete process.env.ACRM_SIGNAL_RUNNER;
      else process.env.ACRM_SIGNAL_RUNNER = previousRunner;
      if (previousSignalRunsModel === undefined) delete process.env.SIGNAL_RUNS_MODEL;
      else process.env.SIGNAL_RUNS_MODEL = previousSignalRunsModel;
      if (previousArgsPath === undefined) delete process.env.ACRM_TEST_CLAUDE_ARGS;
      else process.env.ACRM_TEST_CLAUDE_ARGS = previousArgsPath;
      await cleanup();
      await rm(binDir, { recursive: true, force: true });
      await lix.close();
    }
  });

  it("parses Claude JSON output wrappers with structured_output", async () => {
    const lix = await openTestWorkspace();
    const { dir, cleanup } = await withSignalsDir(hotelSignal);
    try {
      const company = await createRecord(Workspace.fromLix(lix), {
        object_slug: "companies",
        fields: ["name=Hotel Wrapper"],
      });
      const result = await runSignals(Workspace.fromLix(lix), {
        signalsDir: dir,
        records: [{ object_slug: "companies", record_id: company.record_id }],
        mode: "force",
        runner: async () =>
          JSON.stringify({
            type: "result",
            structured_output: {
              outputs: [
                {
                  key: "operator_status",
                  value: "owner_identified",
                  confidence: "high",
                  citations: [{ url: "https://example.test/imprint" }],
                  reasoning: "The fetched imprint identifies the operator.",
                },
                {
                  key: "operator_name",
                  value: "Example Hotels GmbH",
                  confidence: "high",
                  citations: [{ url: "https://example.test/imprint" }],
                  reasoning: "The fetched imprint names the operating entity.",
                },
              ],
            },
          }),
      });
      expect(result.runs_succeeded).toBe(1);
      expect(result.values_written).toBe(2);
    } finally {
      await cleanup();
      await lix.close();
    }
  });

  it("includes runner stderr excerpts in failures", async () => {
    const lix = await openTestWorkspace();
    const { dir, cleanup } = await withSignalsDir(hotelSignal);
    const binDir = await mkdtemp(path.join(tmpdir(), "acrm-claude-fail-bin-"));
    const claudePath = path.join(binDir, "claude");
    const previousPath = process.env.PATH;
    const previousRunner = process.env.ACRM_SIGNAL_RUNNER;
    try {
      await writeFile(
        claudePath,
        `#!/usr/bin/env node
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "private scratchpad should not be logged", signature: "sig" }] } }));
console.log(JSON.stringify({ type: "result", result: "partial claude stdout before failure" }));
console.error("runner stderr: web search quota exhausted for test");
process.exit(17);
`,
        "utf8",
      );
      await chmod(claudePath, 0o755);
      process.env.PATH = `${binDir}:${previousPath ?? ""}`;
      delete process.env.ACRM_SIGNAL_RUNNER;

      const company = await createRecord(Workspace.fromLix(lix), {
        object_slug: "companies",
        fields: ["name=Hotel Runner Failure"],
      });
      const result = await runSignals(Workspace.fromLix(lix), {
        signalsDir: dir,
        records: [{ object_slug: "companies", record_id: company.record_id }],
        mode: "force",
      });
      expect(result.runs_failed).toBe(1);
      expect(result.failures[0]?.message).toBe("signal runner exited with code 17");
      expect(result.failures[0]?.stdout_excerpt).toContain("partial claude stdout");
      expect(result.failures[0]?.stdout_excerpt).not.toContain("private scratchpad");
      expect(result.failures[0]?.stderr_excerpt).toContain("web search quota exhausted");
    } finally {
      process.env.PATH = previousPath;
      if (previousRunner === undefined) delete process.env.ACRM_SIGNAL_RUNNER;
      else process.env.ACRM_SIGNAL_RUNNER = previousRunner;
      await cleanup();
      await rm(binDir, { recursive: true, force: true });
      await lix.close();
    }
  });

  it("migrates signal-owned text outputs to enum outputs and retires removed outputs", async () => {
    const oldSignal = `---
slug: hotel_contact_path
title: Hotel Contact Path
object: companies
---

\`\`\`json acrm-signal
{
  "outputs": [
    {
      "key": "operator_role",
      "attribute": "operator_role",
      "title": "Operator role",
      "type": "text"
    },
    {
      "key": "operator_source_notes",
      "attribute": "operator_source_notes",
      "title": "Operator source notes",
      "type": "text"
    }
  ]
}
\`\`\`

Find the operator role.
`;
    const newSignal = `---
slug: hotel_contact_path
title: Hotel Contact Path
object: companies
---

\`\`\`json acrm-signal
{
  "outputs": [
    {
      "key": "operator_role",
      "attribute": "operator_role",
      "title": "Operator role",
      "type": "select",
      "options": ["owner:Owner", "general_manager:General manager"]
    }
  ]
}
\`\`\`

Classify the operator role.
`;
    const lix = await openTestWorkspace();
    const { dir, cleanup } = await withSignalsDir(oldSignal);
    try {
      const company = await createRecord(Workspace.fromLix(lix), {
        object_slug: "companies",
        fields: ["name=Hotel Migration"],
      });
      await runSignals(Workspace.fromLix(lix), {
        signalsDir: dir,
        records: [{ object_slug: "companies", record_id: company.record_id }],
        mode: "force",
        runner: async () =>
          JSON.stringify({
            outputs: [
              {
                key: "operator_role",
                value: "Owner-operators",
                confidence: "medium",
                citations: [],
                reasoning: "The old signal returned role prose.",
              },
              {
                key: "operator_source_notes",
                value: "Old notes",
                confidence: "medium",
                citations: [],
                reasoning: "The old signal returned notes.",
              },
            ],
          }),
      });

      await writeFile(path.join(dir, "hotel_contact_path.md"), newSignal, "utf8");
      const result = await runSignals(Workspace.fromLix(lix), {
        signalsDir: dir,
        records: [{ object_slug: "companies", record_id: company.record_id }],
        mode: "missing",
        runner: async () =>
          JSON.stringify({
            outputs: [
              {
                key: "operator_role",
                value: "general_manager",
                confidence: "high",
                citations: [{ url: "https://example.test/team" }],
                reasoning: "The current signal returns the enum option id.",
              },
            ],
          }),
      });

      expect(result.runs_succeeded).toBe(1);
      expect(result.values_written).toBe(1);
      const attr = await exec(
        lix,
        "SELECT attribute_type FROM acrm_attribute WHERE object_slug = 'companies' AND attribute_slug = 'operator_role'",
      );
      expect(attr.rows[0]?.attribute_type).toBe("select");
      const active = await exec(
        lix,
        `SELECT attribute_slug, value_json
           FROM acrm_value
          WHERE object_slug = 'companies'
            AND record_id = $1
            AND attribute_slug IN ('operator_role', 'operator_source_notes')
            AND active_until IS NULL
          ORDER BY attribute_slug`,
        [company.record_id],
      );
      expect(active.rows.map((row) => row.attribute_slug)).toEqual(["operator_role"]);
      expect(JSON.parse(active.rows[0]?.value_json as string)).toEqual({
        id: "general_manager",
        title: "General manager",
      });
    } finally {
      await cleanup();
      await lix.close();
    }
  });
});
