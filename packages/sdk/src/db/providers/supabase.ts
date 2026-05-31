import { createPostgresCompatibleProvider } from "./common.js";

export const supabaseProvider = createPostgresCompatibleProvider({
  name: "supabase",
  envKeys: ["SUPABASE_DATABASE_URL"],
  hint: "Set SUPABASE_DATABASE_URL or ACRM_DATABASE_URL to a Supabase Postgres connection string.",
  detect: (url) => {
    const host = url.hostname.toLowerCase();
    return host.endsWith(".supabase.co") || host.endsWith(".supabase.com");
  },
  sslByDefault: true,
});
