import type { Command } from "commander";
import { basename, dirname } from "node:path";
import { AcrmError, ERR } from "@agent-crm/sdk";
import { resolveWorkspacePath } from "../workspace-resolve.js";
import { fail, isJson, ok, setJsonMode } from "../output/json.js";
import { DEFAULT_SYNC_ENGINE_URL, ensureCloudWorkspaceMetadata } from "../lib/cloud-workspace.js";

export function attachGmailSubcommand(parent: Command): void {
  parent
    .command("gmail")
    .description(
      "Connect Gmail through Agent CRM's hosted sync engine. Opens hosted Google OAuth and syncs people, email threads, and email messages into the cloud workspace.",
    )
    .action(async () => {
      const root = parent.parent?.opts() as
        | { workspace?: string; json?: boolean }
        | undefined;
      setJsonMode(root?.json);

      try {
        const workspaceFile = resolveWorkspacePath(root?.workspace);
        const workspaceDir = dirname(workspaceFile);
        const metadata = ensureCloudWorkspaceMetadata(workspaceDir, {
          workspaceId: process.env.ACRM_CLOUD_WORKSPACE_ID,
          clientToken: process.env.ACRM_CLOUD_WORKSPACE_CLIENT_TOKEN,
        });
        const syncEngineUrl = process.env.ACRM_SYNC_ENGINE_URL ?? DEFAULT_SYNC_ENGINE_URL;
        const authUrl = await createGmailConnectUrl({
          syncEngineUrl,
          workspaceId: metadata.workspaceId,
          clientToken: metadata.clientToken,
          workspaceName: basename(workspaceDir),
        });

        if (!isJson()) {
          process.stdout.write(
            [
              "Open this URL to connect Gmail:",
              authUrl,
              "",
              "After OAuth, Gmail sync runs in the background through Agent CRM's hosted sync engine.",
              "",
            ].join("\n")
          );
          return;
        }

        ok({
          auth_url: authUrl,
          workspace_id: metadata.workspaceId,
          sync_engine_url: syncEngineUrl,
        });
      } catch (error) {
        if (error instanceof AcrmError) fail(error.message, error.code, error.hint);
        else fail(error instanceof Error ? error.message : String(error), ERR.IMPORT);
        process.exit(1);
      }
    });
}

async function createGmailConnectUrl(input: {
  syncEngineUrl: string;
  workspaceId: string;
  clientToken: string;
  workspaceName: string;
}): Promise<string> {
  const url = gmailConnectUrl({
    syncEngineUrl: input.syncEngineUrl,
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
  });
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.clientToken}`,
    },
  });
  const payload = await response.json().catch(() => undefined) as
    | { authUrl?: unknown; error?: unknown }
    | undefined;
  if (!response.ok || typeof payload?.authUrl !== "string") {
    throw new AcrmError(
      "failed to start hosted Gmail OAuth",
      ERR.IMPORT,
      typeof payload?.error === "string" ? payload.error : `sync engine returned HTTP ${response.status}`,
    );
  }
  return payload.authUrl;
}

function gmailConnectUrl(input: {
  syncEngineUrl: string;
  workspaceId: string;
  workspaceName: string;
}): string {
  const url = new URL("/integrations/gmail/connect", input.syncEngineUrl);
  url.searchParams.set("workspace_id", input.workspaceId);
  url.searchParams.set("workspace_name", input.workspaceName || "Agent CRM workspace");
  return url.toString();
}

export const __test = {
  createGmailConnectUrl,
  gmailConnectUrl
};
