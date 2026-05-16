import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, normalize, resolve, sep } from "node:path";

export interface Skill {
  // Sanitized skill name. Becomes the install directory name.
  name: string;
  // From the YAML frontmatter `description:` field. Required for the skill to
  // be discoverable by the agent (Claude Code etc. read description before
  // loading the body).
  description: string;
  // Absolute path to the source .md file.
  sourcePath: string;
  // SHA-256 of the source file content. Used to detect drift in the lockfile.
  hash: string;
}

// Sanitization rules ported from vercel-labs/skills to keep our install dirs
// compatible with their tooling: lowercase, non-alphanumeric → '-', strip
// leading/trailing dots and dashes, cap at 255 chars.
export function sanitizeName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._]+/g, "-")
      .replace(/^[.\-]+|[.\-]+$/g, "")
      .substring(0, 255) || "unnamed-skill"
  );
}

// Defends against path-traversal in skill names. Used before any write to make
// sure a malicious frontmatter `name:` can't escape the agent's skills dir.
export function isPathSafe(base: string, target: string): boolean {
  const b = normalize(resolve(base));
  const t = normalize(resolve(target));
  return t === b || t.startsWith(b + sep);
}

// Minimal frontmatter parser. Handles the flat `key: value` shape SKILL.md
// frontmatter actually uses — no nested objects, no multiline strings. Keeps
// us off the `yaml` dependency.
function parseFrontmatter(content: string): Record<string, string> | null {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const result: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (!kv) continue;
    let val = kv[2]!.trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    result[kv[1]!] = val;
  }
  return result;
}

async function readSkillFile(
  filePath: string,
  fallbackName: string,
): Promise<Skill | null> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
  const fm = parseFrontmatter(content);
  if (!fm) return null;
  const description = fm.description;
  if (!description) return null;
  const rawName = fm.name ?? fallbackName;
  return {
    name: sanitizeName(rawName),
    description,
    sourcePath: filePath,
    hash: createHash("sha256").update(content).digest("hex"),
  };
}

/**
 * Discover skills bundled at `rootDir`. Accepts two source layouts:
 *
 *   rootDir/<name>.md           — flat (matches acrm's existing .claude/skills/)
 *   rootDir/<name>/SKILL.md     — directory form (vercel-labs/skills convention)
 *
 * Each skill must have a `description:` field in its YAML frontmatter or it is
 * silently skipped (an agent can't surface a skill without a description).
 */
export async function discoverBundledSkills(rootDir: string): Promise<Skill[]> {
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const out: Skill[] = [];
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".md") && e.name !== "README.md") {
      const skill = await readSkillFile(
        join(rootDir, e.name),
        e.name.slice(0, -3),
      );
      if (skill) out.push(skill);
    } else if (e.isDirectory()) {
      const skill = await readSkillFile(
        join(rootDir, e.name, "SKILL.md"),
        e.name,
      );
      if (skill) out.push(skill);
    }
  }
  return out;
}
