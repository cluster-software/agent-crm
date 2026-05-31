import { createPostgresCompatibleProvider } from "./common.js";

export const postgresProvider = createPostgresCompatibleProvider({
  name: "postgres",
  envKeys: ["ACRM_DATABASE_URL", "DATABASE_URL"],
  hint: "Set ACRM_DATABASE_URL or DATABASE_URL to a Postgres connection string.",
});
