import { describe, expect, it } from "vitest";
import { openTestWorkspace } from "../test/open-test-db.js";
import { exec } from "../../../sdk/src/db/execute.js";
import { createRecord, updateRecord, Workspace } from "@agent-crm/sdk";
import { AcrmError } from "@agent-crm/sdk";
import { encode } from "@agent-crm/sdk";

// These tests cover the schema-mutation surface (`acrm object create`,
// `acrm attribute add`, `acrm attribute edit-options`) and the
// `acrm records create` verb. They exercise the same SQL the commands run via
// the same `exec`/`upsert` helpers; the CLI layer is a thin commander wrapper
// validated separately by the smoke-test in scripts/.

async function readAttribute(
  db: Awaited<ReturnType<typeof openTestWorkspace>>,
  object_slug: string,
  attribute_slug: string,
) {
  const r = await exec(
    db,
    "SELECT attribute_type, is_multivalued, is_unique, config_json FROM acrm_attribute WHERE object_slug = $1 AND attribute_slug = $2",
    [object_slug, attribute_slug],
  );
  return r.rows[0] ?? null;
}

describe("object create (raw INSERT)", () => {
  it("registers a custom object alongside the built-ins", async () => {
    const db = await openTestWorkspace();
    try {
      await exec(
        db,
        "INSERT INTO acrm_object (object_slug, singular_name, plural_name) VALUES ($1, $2, $3)",
        ["candidates", "Candidate", "Candidates"],
      );
      const r = await exec(
        db,
        "SELECT object_slug FROM acrm_object ORDER BY object_slug",
      );
      const slugs = r.rows.map((row) => row.object_slug as string);
      expect(slugs).toContain("candidates");
      expect(slugs).toContain("people");
    } finally {
      await db.close();
    }
  });
});

function parseJsonColumn(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

describe("attribute add (raw INSERT)", () => {
  it("adds a status attribute with options to a custom object", async () => {
    const db = await openTestWorkspace();
    try {
      await exec(
        db,
        "INSERT INTO acrm_object (object_slug, singular_name, plural_name) VALUES ($1, $2, $3)",
        ["candidates", "Candidate", "Candidates"],
      );
      const config = {
        options: [
          { id: "sourced", title: "Sourced" },
          { id: "screen", title: "Screen" },
          { id: "onsite", title: "Onsite" },
          { id: "offer", title: "Offer" },
        ],
      };
      await exec(
        db,
        `INSERT INTO acrm_attribute
          (object_slug, attribute_slug, title, attribute_type,
           is_multivalued, is_unique, config_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          "candidates",
          "stage",
          "Stage",
          "status",
          false,
          false,
          JSON.stringify(config),
        ],
      );
      const row = await readAttribute(db, "candidates", "stage");
      expect(row).not.toBeNull();
      expect(row!.attribute_type).toBe("status");
      expect((parseJsonColumn(row!.config_json) as { options: unknown }).options).toEqual(
        config.options,
      );
    } finally {
      await db.close();
    }
  });
});

describe("encode() enum validation", () => {
  it("accepts a valid option id", () => {
    const out = encode("status", "sourced", {
      options: [
        { id: "sourced", title: "Sourced" },
        { id: "screen", title: "Screen" },
      ],
    });
    expect(out).toEqual({ id: "sourced", title: "Sourced" });
  });

  it("accepts a valid option title (case-insensitive)", () => {
    const out = encode("status", "SCREEN", {
      options: [
        { id: "sourced", title: "Sourced" },
        { id: "screen", title: "Screen" },
      ],
    });
    expect(out).toEqual({ id: "screen", title: "Screen" });
  });

  it("throws when input doesn't match a configured option", () => {
    expect(() =>
      encode("status", "won_lol", {
        options: [
          { id: "lead", title: "Lead" },
          { id: "won", title: "Won" },
        ],
      }),
    ).toThrow(/invalid status/);
  });

  it("hints the user toward `attribute edit-options`", async () => {
    const { AcrmError } = await import("@agent-crm/sdk");
    try {
      encode("status", "renewed", {
        options: [{ id: "won", title: "Won" }],
      });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AcrmError);
      expect((e as InstanceType<typeof AcrmError>).hint).toMatch(
        /edit-options/,
      );
    }
  });

  it("free-form mode (no options) still works", () => {
    const out = encode("status", "anything", undefined);
    expect(out).toEqual({ title: "anything" });
  });
});

describe("records create", () => {
  it("creates a deal with name + stage + value", async () => {
    const db = await openTestWorkspace();
    try {
      const result = await createRecord(Workspace.fromDatabase(db), {
        object_slug: "deals",
        fields: [
          "name=Acme renewal",
          "stage=in_progress",
          "value=50000",
        ],
      });
      expect(result.created).toBe(true);
      expect(result.values_inserted).toBe(3);

      const vals = await exec(
        db,
        "SELECT attribute_slug, value_json FROM acrm_value WHERE object_slug = 'deals' AND record_id = $1 AND active_until IS NULL ORDER BY attribute_slug",
        [result.record_id],
      );
      const byAttr = new Map(
        vals.rows.map((r) => [
          r.attribute_slug as string,
          parseJsonColumn(r.value_json) as Record<string, unknown>,
        ]),
      );
      expect(byAttr.get("name")).toEqual({ value: "Acme renewal" });
      expect(byAttr.get("stage")).toEqual({
        id: "in_progress",
        title: "In Progress",
      });
      expect(byAttr.get("value")).toEqual({
        currency_value: 50000,
        currency_code: "USD",
      });
    } finally {
      await db.close();
    }
  });

  it("rejects unknown attributes before writing", async () => {
    const db = await openTestWorkspace();
    try {
      await expect(
        createRecord(Workspace.fromDatabase(db), {
          object_slug: "deals",
          fields: ["name=Acme", "bogus=hello"],
        }),
      ).rejects.toThrow(/unknown attribute/);

      // No partial record left behind.
      const recs = await exec(
        db,
        "SELECT COUNT(*) AS n FROM acrm_record WHERE object_slug = 'deals'",
      );
      expect(recs.rows[0]!.n).toBe(0);
    } finally {
      await db.close();
    }
  });

  it("rejects an invalid status against a locked enum", async () => {
    const db = await openTestWorkspace();
    try {
      await expect(
        createRecord(Workspace.fromDatabase(db), {
          object_slug: "deals",
          fields: ["name=Hiring D.V.", "stage=sourced"],
        }),
      ).rejects.toThrow(/invalid status/);
    } finally {
      await db.close();
    }
  });

  it("does not leave an orphan record_id when validation fails after some fields are valid", async () => {
    const db = await openTestWorkspace();
    try {
      await expect(
        createRecord(Workspace.fromDatabase(db), {
          object_slug: "deals",
          fields: ["name=Hiring D.V.", "stage=sourced"], // name valid, stage invalid
        }),
      ).rejects.toThrow();
      const recs = await exec(
        db,
        "SELECT COUNT(*) AS n FROM acrm_record WHERE object_slug = 'deals'",
      );
      expect(recs.rows[0]!.n).toBe(0);
    } finally {
      await db.close();
    }
  });

  it("rejects an unknown object slug", async () => {
    const db = await openTestWorkspace();
    try {
      await expect(
        createRecord(Workspace.fromDatabase(db), {
          object_slug: "candidates",
          fields: ["name=Daria"],
        }),
      ).rejects.toThrow(/unknown object/);
    } finally {
      await db.close();
    }
  });

  it("parses record-reference values as <target_object>:<target_record_id>", async () => {
    const db = await openTestWorkspace();
    try {
      const company = await createRecord(Workspace.fromDatabase(db), {
        object_slug: "companies",
        fields: ["name=Acme Co", "domains=acme.test"],
      });
      const deal = await createRecord(Workspace.fromDatabase(db), {
        object_slug: "deals",
        fields: [
          "name=Acme renewal",
          `associated_company=companies:${company.record_id}`,
        ],
      });
      const refs = await exec(
        db,
        "SELECT ref_object, ref_record_id FROM acrm_value WHERE object_slug = 'deals' AND record_id = $1 AND attribute_slug = 'associated_company' AND active_until IS NULL",
        [deal.record_id],
      );
      expect(refs.rows[0]!.ref_object).toBe("companies");
      expect(refs.rows[0]!.ref_record_id).toBe(company.record_id);
    } finally {
      await db.close();
    }
  });

  it("supports multivalued attributes via repeated --field", async () => {
    const db = await openTestWorkspace();
    try {
      const result = await createRecord(Workspace.fromDatabase(db), {
        object_slug: "people",
        fields: [
          "name=Liam",
          "email_addresses=liam@home.com",
          "email_addresses=liam@work.com",
        ],
      });
      const emails = await exec(
        db,
        "SELECT normalized_key FROM acrm_value WHERE object_slug = 'people' AND record_id = $1 AND attribute_slug = 'email_addresses' AND active_until IS NULL ORDER BY normalized_key",
        [result.record_id],
      );
      expect(emails.rows.map((r) => r.normalized_key)).toEqual([
        "liam@home.com",
        "liam@work.com",
      ]);
    } finally {
      await db.close();
    }
  });
});

describe("records update", () => {
  it("advances a single-valued field (replaces the current value)", async () => {
    const db = await openTestWorkspace();
    try {
      const deal = await createRecord(Workspace.fromDatabase(db), {
        object_slug: "deals",
        fields: ["name=Acme renewal", "stage=lead"],
      });
      const result = await updateRecord(Workspace.fromDatabase(db), {
        object_slug: "deals",
        record_id: deal.record_id,
        fields: ["stage=in_progress"],
      });
      expect(result.updated).toBe(true);
      expect(result.values_changed).toBe(1);

      const active = await exec(
        db,
        "SELECT value_json ->> 'id' AS id FROM acrm_value WHERE object_slug = 'deals' AND record_id = $1 AND attribute_slug = 'stage' AND active_until IS NULL",
        [deal.record_id],
      );
      expect(active.rows.length).toBe(1);
      expect(active.rows[0]!.id).toBe("in_progress");
    } finally {
      await db.close();
    }
  });

  it("rejects updates to a missing record", async () => {
    const db = await openTestWorkspace();
    try {
      await expect(
        updateRecord(Workspace.fromDatabase(db), {
          object_slug: "deals",
          record_id: "019e2d00-0000-7000-0000-000000000000",
          fields: ["stage=in_progress"],
        }),
      ).rejects.toThrow(/record not found/);
    } finally {
      await db.close();
    }
  });

  it("rejects invalid enum values without touching the record", async () => {
    const db = await openTestWorkspace();
    try {
      const deal = await createRecord(Workspace.fromDatabase(db), {
        object_slug: "deals",
        fields: ["name=Acme", "stage=lead"],
      });
      await expect(
        updateRecord(Workspace.fromDatabase(db), {
          object_slug: "deals",
          record_id: deal.record_id,
          fields: ["stage=sourced"],
        }),
      ).rejects.toThrow(/invalid status/);
      // The original lead stage is still active.
      const active = await exec(
        db,
        "SELECT value_json ->> 'id' AS id FROM acrm_value WHERE object_slug = 'deals' AND record_id = $1 AND attribute_slug = 'stage' AND active_until IS NULL",
        [deal.record_id],
      );
      expect(active.rows[0]!.id).toBe("lead");
    } finally {
      await db.close();
    }
  });

  it("rejects empty --field list", async () => {
    const db = await openTestWorkspace();
    try {
      const deal = await createRecord(Workspace.fromDatabase(db), {
        object_slug: "deals",
        fields: ["name=Acme", "stage=lead"],
      });
      await expect(
        updateRecord(Workspace.fromDatabase(db), {
          object_slug: "deals",
          record_id: deal.record_id,
          fields: [],
        }),
      ).rejects.toThrow(/nothing to update/);
    } finally {
      await db.close();
    }
  });

  it("adds another value to a multivalued attribute (dedupe handles collapse)", async () => {
    const db = await openTestWorkspace();
    try {
      const person = await createRecord(Workspace.fromDatabase(db), {
        object_slug: "people",
        fields: ["name=Liam", "email_addresses=liam@home.com"],
      });
      await updateRecord(Workspace.fromDatabase(db), {
        object_slug: "people",
        record_id: person.record_id,
        fields: ["email_addresses=liam@work.com"],
      });
      const emails = await exec(
        db,
        "SELECT normalized_key FROM acrm_value WHERE object_slug = 'people' AND record_id = $1 AND attribute_slug = 'email_addresses' AND active_until IS NULL ORDER BY normalized_key",
        [person.record_id],
      );
      expect(emails.rows.map((r) => r.normalized_key)).toEqual([
        "liam@home.com",
        "liam@work.com",
      ]);
    } finally {
      await db.close();
    }
  });
});

describe("end-to-end: custom hiring pipeline", () => {
  it("registers an object + attributes + records that the ax-eval agents could not", async () => {
    const db = await openTestWorkspace();
    try {
      // 1. Register the object.
      await exec(
        db,
        "INSERT INTO acrm_object (object_slug, singular_name, plural_name) VALUES ($1, $2, $3)",
        ["candidates", "Candidate", "Candidates"],
      );

      // 2. Add fields with custom status options (the affordance that was
      // missing — agents had to overload deals.next_step).
      await exec(
        db,
        `INSERT INTO acrm_attribute
          (object_slug, attribute_slug, title, attribute_type,
           is_multivalued, is_unique, config_json)
         VALUES ('candidates', 'name', 'Name', 'personal-name', $1, $2, NULL)`,
        [false, false],
      );
      await exec(
        db,
        `INSERT INTO acrm_attribute
          (object_slug, attribute_slug, title, attribute_type,
           is_multivalued, is_unique, config_json)
         VALUES ('candidates', 'stage', 'Stage', 'status', $1, $2, $3)`,
        [
          false,
          false,
          JSON.stringify({
            options: [
              { id: "sourced", title: "Sourced" },
              { id: "screen", title: "Screen" },
              { id: "onsite", title: "Onsite" },
              { id: "offer", title: "Offer" },
            ],
          }),
        ],
      );

      // 3. Create candidate records that the locked deals.stage enum could
      // never have accepted.
      await createRecord(Workspace.fromDatabase(db), {
        object_slug: "candidates",
        fields: ["name=Daria Volkov", "stage=screen"],
      });
      await createRecord(Workspace.fromDatabase(db), {
        object_slug: "candidates",
        fields: ["name=Liam O'Connell", "stage=onsite"],
      });

      const r = await exec(
        db,
        "SELECT value_json ->> 'id' AS stage_id, COUNT(*) AS n FROM acrm_value WHERE object_slug = 'candidates' AND attribute_slug = 'stage' AND active_until IS NULL GROUP BY value_json ->> 'id' ORDER BY stage_id",
      );
      expect(r.rows.map((x) => x.stage_id).sort()).toEqual(["onsite", "screen"]);
    } finally {
      await db.close();
    }
  });
});
