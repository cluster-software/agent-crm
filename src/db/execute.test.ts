import { describe, expect, it } from "vitest";
import { openTestWorkspace } from "../test/open-test-lix.js";
import { exec } from "./execute.js";
import { AcrmError } from "../lib/errors.js";

describe("exec error mapping", () => {
  it("upgrades LIX_TABLE_NOT_FOUND hint when the missing table is a known object_slug", async () => {
    const lix = await openTestWorkspace();
    try {
      await exec(lix, "SELECT * FROM people");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AcrmError);
      const err = e as AcrmError;
      expect(err.code).toBe("LIX_TABLE_NOT_FOUND");
      expect(err.hint).toMatch(/object_slug/);
      expect(err.hint).toMatch(/acrm_record/);
      expect(err.hint).toMatch(/people/);
    } finally {
      await lix.close();
    }
  });

  it("falls back to generic EAV hint for unknown tables", async () => {
    const lix = await openTestWorkspace();
    try {
      await exec(lix, "SELECT * FROM foozle");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AcrmError);
      const err = e as AcrmError;
      expect(err.code).toBe("LIX_TABLE_NOT_FOUND");
      expect(err.hint).toMatch(/EAV/);
    } finally {
      await lix.close();
    }
  });
});
