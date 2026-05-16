// @agent-crm/sdk public API.
//
// Most consumers should import from "@agent-crm/sdk" directly. A handful of
// modules share symbol names (e.g. mapProfile in linkedin-mapping vs
// x-mapping) — those are reachable via subpath imports like
// "@agent-crm/sdk/integrations/linkedin-mapping.js".

export * from "./db/execute.js";
export * from "./db/upsert.js";
export * from "./domain/resolve-person.js";
export * from "./domain/values.js";

// integrations: apify-linkedin / apify-x / linkedin-mapping / x-mapping have
// overlapping symbol names — import them via subpath, e.g.
// "@agent-crm/sdk/integrations/apify-linkedin.js".
export * from "./integrations/apify-post.js";
export * from "./integrations/granola.js";
export * from "./integrations/mcp-http-client.js";
export * from "./integrations/post-mapping.js";
export * from "./integrations/provider.js";
export * from "./integrations/providers.js";
export * from "./integrations/transcript.js";

export * from "./lib/errors.js";
export * from "./lib/ids.js";
export * from "./lib/oauth-pkce.js";
export * from "./lib/time.js";
export * from "./lib/token-cache.js";
export * from "./lib/uuidv7.js";

export * from "./workspace/schemas/index.js";
export { Workspace } from "./workspace.js";

export * from "./operations/execute.js";
export * from "./operations/init.js";
export * from "./operations/import-csv.js";
export * from "./operations/import-linkedin.js";
export * from "./operations/import-post.js";
export * from "./operations/import-transcript.js";
export * from "./operations/import-x.js";
export * from "./operations/records.js";
export * from "./operations/schema.js";
