import type { Lix } from "@lix-js/sdk";
import { execScalar } from "../db/execute.js";

export async function generateUuid(lix: Lix): Promise<string> {
  const id = await execScalar<string>(lix, "SELECT lix_uuid_v7() AS id");
  if (!id) throw new Error("lix_uuid_v7() returned null");
  return id;
}
