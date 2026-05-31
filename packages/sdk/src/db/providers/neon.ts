import { createPostgresCompatibleProvider } from "./common.js";

export const neonProvider = createPostgresCompatibleProvider({
  name: "neon",
  envKeys: ["NEON_DATABASE_URL"],
  hint: "Set NEON_DATABASE_URL or ACRM_DATABASE_URL to a Neon Postgres connection string.",
  detect: (url) => url.hostname.toLowerCase().endsWith(".neon.tech"),
  sslByDefault: true,
});
