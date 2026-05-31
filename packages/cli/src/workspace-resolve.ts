import path from "node:path";
import {
  Workspace,
  isPostgresDatabaseUrl,
  resolveDatabaseProviderConfig,
  type AcrmDatabase,
  type ResolvedDatabaseProviderConfig,
} from "@agent-crm/sdk";
import { loadDotenv } from "./lib/dotenv.js";

export function resolveDatabaseUrl(databaseUrl?: string): string {
  return resolveDatabaseConfig(databaseUrl).databaseUrl;
}

export function resolveDatabaseConfig(databaseUrl?: string): ResolvedDatabaseProviderConfig {
  loadDotenv(process.cwd());
  return resolveDatabaseProviderConfig({
    databaseUrl,
    env: process.env,
  });
}

export function resolveWorkspacePath(workspace?: string): string {
  return resolveDatabaseUrl(workspace);
}

export function localWorkspaceDir(workspace: string): string {
  return isPostgresDatabaseUrl(workspace) ? process.cwd() : path.dirname(workspace);
}

export function workspaceDisplayName(preferred?: string): string {
  return preferred ?? process.env.ACRM_WORKSPACE_NAME ?? "Agent CRM workspace";
}

export async function openResolvedWorkspace(
  workspace: string,
  db?: AcrmDatabase,
): Promise<Workspace> {
  return db
    ? await Workspace.open({ db })
    : await Workspace.open(resolveDatabaseConfig(workspace));
}
