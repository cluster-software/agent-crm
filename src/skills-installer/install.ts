import { existsSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  AGENTS,
  detectInstalledAgents,
  type AgentName,
} from "./agents.js";
import { discoverBundledSkills, isPathSafe } from "./skill.js";
import {
  readLockfile,
  writeLockfile,
  type LockfileEntry,
} from "./lockfile.js";

export interface SyncOptions {
  // Absolute path to the bundled skills source dir (e.g. <pkg>/.claude/skills).
  bundledSkillsDir: string;
  // Recorded in the lockfile so we can later attribute skills to a CLI version.
  acrmVersion: string;
  // Restrict targets. Defaults to whichever agents we detect on the system.
  agents?: AgentName[];
}

export interface SyncResult {
  installed: string[];
  updated: string[];
  removed: string[];
  targetAgents: AgentName[];
  skippedAgents: AgentName[];
}

/**
 * Reconcile the on-disk skill set with the bundled source. Idempotent:
 *
 *   - skills whose hash matches the lockfile AND whose files still exist on
 *     disk for every target agent are left alone (cheap, common case)
 *   - new skills + drifted skills are written
 *   - skills present in the lockfile but no longer bundled are removed
 *
 * We only ever touch paths recorded in the lockfile — user-authored skills in
 * the same directories are never disturbed.
 */
export async function syncSkills(opts: SyncOptions): Promise<SyncResult> {
  const targetAgents = opts.agents ?? detectInstalledAgents();
  const skippedAgents = (Object.keys(AGENTS) as AgentName[]).filter(
    (a) => !targetAgents.includes(a),
  );

  const bundled = await discoverBundledSkills(opts.bundledSkillsDir);
  const lock = await readLockfile();
  const bundledNames = new Set(bundled.map((s) => s.name));
  const result: SyncResult = {
    installed: [],
    updated: [],
    removed: [],
    targetAgents,
    skippedAgents,
  };

  for (const skill of bundled) {
    const prev = lock.skills[skill.name];
    const missingOnDisk = targetAgents.some(
      (a) => !prev?.agents[a] || !existsSync(prev.agents[a]!.path),
    );
    if (prev && prev.hash === skill.hash && !missingOnDisk) continue;

    const entry: LockfileEntry = {
      sourceType: "bundled",
      hash: skill.hash,
      installedAt: new Date().toISOString(),
      agents: {},
    };

    for (const agentName of targetAgents) {
      const base = AGENTS[agentName].globalDir();
      const target = join(base, skill.name);
      if (!isPathSafe(base, target)) continue;
      await rm(target, { recursive: true, force: true });
      await mkdir(target, { recursive: true });
      await copyFile(skill.sourcePath, join(target, "SKILL.md"));
      entry.agents[agentName] = { path: target };
    }

    (prev ? result.updated : result.installed).push(skill.name);
    lock.skills[skill.name] = entry;
  }

  for (const name of Object.keys(lock.skills)) {
    if (bundledNames.has(name)) continue;
    await removeSkillEntry(lock.skills[name]!);
    delete lock.skills[name];
    result.removed.push(name);
  }

  lock.acrmVersion = opts.acrmVersion;
  await writeLockfile(lock);
  return result;
}

export async function removeAllSkills(): Promise<string[]> {
  const lock = await readLockfile();
  const removed = Object.keys(lock.skills);
  for (const entry of Object.values(lock.skills)) {
    await removeSkillEntry(entry);
  }
  lock.skills = {};
  await writeLockfile(lock);
  return removed;
}

async function removeSkillEntry(entry: LockfileEntry): Promise<void> {
  for (const [agentName, info] of Object.entries(entry.agents)) {
    if (!info) continue;
    const agent = AGENTS[agentName as AgentName];
    if (!agent) continue;
    const base = agent.globalDir();
    if (!isPathSafe(base, info.path)) continue;
    await rm(info.path, { recursive: true, force: true });
  }
}
