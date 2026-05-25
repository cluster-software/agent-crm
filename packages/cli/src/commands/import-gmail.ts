import type { Command } from "commander";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { AcrmError, ERR } from "@agent-crm/sdk";
import { resolveWorkspacePath } from "../workspace-resolve.js";
import { fail, isJson, ok, setJsonMode } from "../output/json.js";

const DEFAULT_SYNC_ENGINE_URL = "https://agent-crm-sync-engine.onrender.com";
const CLOUD_METADATA_FILENAME = ".agent-crm-cloud.json";

type CloudMetadata = {
  workspaceId?: string;
  clientToken?: string;
  createdAt?: string;
};

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

function ensureCloudWorkspaceMetadata(
  workspaceDir: string,
  preferred: { workspaceId?: string; clientToken?: string } = {},
): { workspaceId: string; clientToken: string } {
  const metadataPath = join(workspaceDir, CLOUD_METADATA_FILENAME);
  const existing = readCloudMetadata(metadataPath);
  const workspaceId = existing.workspaceId || preferred.workspaceId || randomUUID();
  const clientToken = existing.clientToken || preferred.clientToken || randomUUID();

  if (workspaceId !== existing.workspaceId || clientToken !== existing.clientToken) {
    writeFileSync(
      metadataPath,
      `${JSON.stringify({
        ...existing,
        workspaceId,
        clientToken,
        createdAt: existing.createdAt ?? new Date().toISOString(),
      }, null, 2)}\n`,
      "utf8"
    );
  }

  return { workspaceId, clientToken };
}

function readCloudMetadata(metadataPath: string): CloudMetadata {
  try {
    const parsed = JSON.parse(readFileSync(metadataPath, "utf8")) as CloudMetadata;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
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
