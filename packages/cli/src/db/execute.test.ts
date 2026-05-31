import { describe, expect, it } from "vitest";
import { openTestWorkspace } from "../test/open-test-db.js";
import { exec } from "@agent-crm/sdk";
import { AcrmError } from "@agent-crm/sdk";

describe("exec error mapping", () => {
  it("upgrades missing-table hints when the missing table is a known object_slug", async () => {
    const db = await openTestWorkspace();
    try {
      await exec(db, "SELECT * FROM people");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AcrmError);
      const err = e as AcrmError;
      expect(err.code).toBe("POSTGRES_42P01");
      expect(err.hint).toMatch(/object_slug/);
      expect(err.hint).toMatch(/acrm_record/);
      expect(err.hint).toMatch(/people/);
    } finally {
      await db.close();
    }
  });

  it("falls back to generic EAV hint for unknown tables", async () => {
    const db = await openTestWorkspace();
    try {
      await exec(db, "SELECT * FROM foozle");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AcrmError);
      const err = e as AcrmError;
      expect(err.code).toBe("POSTGRES_42P01");
      expect(err.hint).toMatch(/EAV/);
    } finally {
      await db.close();
    }
  });
});
