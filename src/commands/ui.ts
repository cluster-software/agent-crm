import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import type { Command } from "commander";
import type { Lix } from "@lix-js/sdk";
import { findWorkspace, openWorkspace } from "../workspace/open.js";
import { exec } from "../db/execute.js";
import { fail, setJsonMode } from "../output/json.js";
import { AcrmError, ERR } from "../lib/errors.js";

type Person = {
  id: string;
  name: string | null;
  job_title: string | null;
  linkedin_url: string | null;
  company_id: string | null;
};

type Company = {
  id: string;
  name: string | null;
  description: string | null;
};

type Counts = { people: number; companies: number; deals: number };

async function loadPeople(lix: Lix): Promise<Person[]> {
  const r = await exec(
    lix,
    `SELECT
       p.record_id AS id,
       v_name.value_json AS name_json,
       v_role.value_json AS role_json,
       v_li.value_json AS li_json,
       v_ref.ref_record_id AS company_id
     FROM acrm_record p
     LEFT JOIN acrm_value v_name
       ON v_name.record_id = p.record_id
       AND v_name.attribute_slug = 'name'
       AND v_name.active_until IS NULL
     LEFT JOIN acrm_value v_role
       ON v_role.record_id = p.record_id
       AND v_role.attribute_slug = 'job_title'
       AND v_role.active_until IS NULL
     LEFT JOIN acrm_value v_li
       ON v_li.record_id = p.record_id
       AND v_li.attribute_slug = 'linkedin_url'
       AND v_li.active_until IS NULL
     LEFT JOIN acrm_value v_ref
       ON v_ref.record_id = p.record_id
       AND v_ref.attribute_slug = 'company'
       AND v_ref.active_until IS NULL
     WHERE p.object_slug = 'people'`,
  );
  const out: Person[] = r.rows.map((row) => {
    const nameObj = parseJson(row.name_json);
    const roleObj = parseJson(row.role_json);
    const liObj = parseJson(row.li_json);
    return {
      id: row.id as string,
      name: (nameObj?.full_name as string | undefined) ?? null,
      job_title: (roleObj?.value as string | undefined) ?? null,
      linkedin_url: (liObj?.value as string | undefined) ?? null,
      company_id: (row.company_id as string | null) ?? null,
    };
  });
  out.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  return out;
}

async function loadCompanies(lix: Lix): Promise<Company[]> {
  const r = await exec(
    lix,
    `SELECT
       c.record_id AS id,
       v_name.value_json AS name_json,
       v_desc.value_json AS desc_json
     FROM acrm_record c
     LEFT JOIN acrm_value v_name
       ON v_name.record_id = c.record_id
       AND v_name.attribute_slug = 'name'
       AND v_name.active_until IS NULL
     LEFT JOIN acrm_value v_desc
       ON v_desc.record_id = c.record_id
       AND v_desc.attribute_slug = 'description'
       AND v_desc.active_until IS NULL
     WHERE c.object_slug = 'companies'`,
  );
  const out: Company[] = r.rows.map((row) => {
    const nameObj = parseJson(row.name_json);
    const descObj = parseJson(row.desc_json);
    return {
      id: row.id as string,
      name: (nameObj?.value as string | undefined) ?? null,
      description: (descObj?.value as string | undefined) ?? null,
    };
  });
  out.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  return out;
}

async function loadCounts(lix: Lix): Promise<Counts> {
  const r = await exec(
    lix,
    `SELECT object_slug, COUNT(*) AS n FROM acrm_record GROUP BY object_slug`,
  );
  const counts: Counts = { people: 0, companies: 0, deals: 0 };
  for (const row of r.rows) {
    const slug = row.object_slug as string;
    const n = Number(row.n);
    if (slug === "people") counts.people = n;
    else if (slug === "companies") counts.companies = n;
    else if (slug === "deals") counts.deals = n;
  }
  return counts;
}

function parseJson(v: unknown): Record<string, unknown> | null {
  if (typeof v !== "string" || !v.length) return null;
  try {
    return JSON.parse(v) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 38%, 32%)`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

const STYLES = `
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; height: 100%; }
body {
  font-family: "Inter", -apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif;
  font-size: 13px;
  line-height: 1.45;
  background: #0a0a0a;
  color: #e6e6e6;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  letter-spacing: -0.005em;
}
.app { display: grid; grid-template-columns: 220px 1fr; height: 100vh; }
.sidebar {
  background: #0a0a0a;
  border-right: 1px solid rgba(255,255,255,0.06);
  padding: 14px 8px;
  overflow-y: auto;
}
.workspace {
  padding: 4px 10px 14px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: #ededed;
}
.workspace-icon {
  width: 18px; height: 18px;
  border-radius: 5px;
  background: linear-gradient(135deg, #5e6ad2 0%, #4a8af4 100%);
  flex: none;
}
.nav-section { margin-top: 10px; }
.nav-label {
  font-size: 11px;
  color: #6a6a6a;
  padding: 4px 10px 6px;
  font-weight: 500;
}
.nav-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 10px;
  border-radius: 5px;
  color: #c0c0c0;
  text-decoration: none;
  font-size: 13px;
}
.nav-item:hover { background: rgba(255,255,255,0.04); color: #e6e6e6; }
.nav-item.active { background: rgba(255,255,255,0.06); color: #fff; }
.nav-item .left { display: flex; align-items: center; gap: 8px; }
.nav-item .icon { width: 14px; height: 14px; opacity: 0.75; flex: none; }
.nav-item.active .icon { opacity: 1; }
.nav-item .count { font-size: 11px; color: #6a6a6a; font-variant-numeric: tabular-nums; }
.main { overflow: auto; }
.topbar {
  height: 48px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  display: flex;
  align-items: center;
  padding: 0 24px;
  gap: 10px;
  position: sticky;
  top: 0;
  background: #0a0a0a;
  z-index: 1;
}
.topbar h1 { font-size: 13px; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
.topbar .count {
  font-size: 12px;
  color: #6a6a6a;
  font-variant-numeric: tabular-nums;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
thead tr { border-bottom: 1px solid rgba(255,255,255,0.06); }
th {
  text-align: left;
  font-weight: 500;
  color: #8a8a8a;
  font-size: 12px;
  padding: 10px 16px;
  background: #0a0a0a;
  position: sticky;
  top: 48px;
  z-index: 1;
}
tbody tr { border-bottom: 1px solid rgba(255,255,255,0.04); }
tbody tr:last-child { border-bottom: none; }
tbody tr:hover { background: rgba(255,255,255,0.025); }
td {
  padding: 10px 16px;
  color: #d8d8d8;
  vertical-align: middle;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 360px;
}
td.muted { color: #555; }
.avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px; height: 22px;
  border-radius: 50%;
  color: rgba(255,255,255,0.95);
  font-size: 10px;
  font-weight: 600;
  margin-right: 10px;
  vertical-align: middle;
  flex: none;
}
.name-cell { display: flex; align-items: center; min-width: 0; }
.name-cell span:last-child { overflow: hidden; text-overflow: ellipsis; }
a { color: #6e9fff; text-decoration: none; }
a:hover { text-decoration: underline; }
.mono {
  font-family: "JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace;
  font-size: 12px;
  color: #9a9a9a;
}
.empty {
  padding: 80px 40px;
  text-align: center;
  color: #6a6a6a;
}
.empty h2 { font-size: 14px; font-weight: 500; color: #a0a0a0; margin: 0 0 6px; }
.empty p { margin: 0; font-size: 12px; }
`;

const ICON_PEOPLE = `<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="6" r="2.5"/><path d="M3 13c0-2.5 2.2-4 5-4s5 1.5 5 4"/></svg>`;
const ICON_COMPANIES = `<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="3" width="10" height="10" rx="1"/><path d="M6 6h1M9 6h1M6 9h1M9 9h1"/></svg>`;
const ICON_DEALS = `<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 2l5 4-5 8-5-8z"/></svg>`;

function renderShell(opts: {
  workspace: string;
  active: "people" | "companies" | "deals";
  counts: Counts;
  body: string;
}): string {
  const { workspace, active, counts, body } = opts;
  const navItem = (
    href: string,
    key: "people" | "companies" | "deals",
    label: string,
    icon: string,
    count: number,
  ) => `<a class="nav-item ${active === key ? "active" : ""}" href="${href}">
    <span class="left">${icon}<span>${label}</span></span>
    <span class="count">${count}</span>
  </a>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(workspace)} — Agent CRM</title>
<style>${STYLES}</style>
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="workspace">
      <span class="workspace-icon"></span>
      <span>${escapeHtml(workspace)}</span>
    </div>
    <div class="nav-section">
      <div class="nav-label">Objects</div>
      ${navItem("/people", "people", "People", ICON_PEOPLE, counts.people)}
      ${navItem("/companies", "companies", "Companies", ICON_COMPANIES, counts.companies)}
      ${navItem("/deals", "deals", "Deals", ICON_DEALS, counts.deals)}
    </div>
  </aside>
  <main class="main">${body}</main>
</div>
</body>
</html>`;
}

function renderPeoplePage(
  people: Person[],
  companyById: Map<string, string>,
  workspace: string,
  counts: Counts,
): string {
  const rows = people
    .map((p) => {
      const display = p.name ?? "(unnamed)";
      const color = avatarColor(p.id);
      const company =
        p.company_id && companyById.get(p.company_id)
          ? escapeHtml(companyById.get(p.company_id)!)
          : `<span class="muted">—</span>`;
      const role = p.job_title
        ? escapeHtml(p.job_title)
        : `<span class="muted">—</span>`;
      const linkedin = p.linkedin_url
        ? `<a class="mono" href="https://${escapeHtml(p.linkedin_url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(p.linkedin_url)}</a>`
        : `<span class="muted">—</span>`;
      return `<tr>
        <td><div class="name-cell"><span class="avatar" style="background:${color}">${escapeHtml(initials(display))}</span><span>${escapeHtml(display)}</span></div></td>
        <td>${role}</td>
        <td>${company}</td>
        <td>${linkedin}</td>
      </tr>`;
    })
    .join("");

  const body = `
    <div class="topbar">
      <h1>People</h1>
      <span class="count">${people.length}</span>
    </div>
    ${
      people.length
        ? `<table>
          <thead><tr><th>Name</th><th>Role</th><th>Company</th><th>LinkedIn</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`
        : `<div class="empty"><h2>No people yet</h2><p>Run <span class="mono">acrm import csv ./leads.csv</span> to add some.</p></div>`
    }
  `;
  return renderShell({ workspace, active: "people", counts, body });
}

function renderCompaniesPage(
  companies: Company[],
  peopleByCompany: Map<string, number>,
  workspace: string,
  counts: Counts,
): string {
  const rows = companies
    .map((c) => {
      const display = c.name ?? "(unnamed)";
      const color = avatarColor(c.id);
      const desc = c.description
        ? escapeHtml(c.description)
        : `<span class="muted">—</span>`;
      const headcount = peopleByCompany.get(c.id) ?? 0;
      return `<tr>
        <td><div class="name-cell"><span class="avatar" style="background:${color}">${escapeHtml(initials(display))}</span><span>${escapeHtml(display)}</span></div></td>
        <td>${desc}</td>
        <td>${headcount === 0 ? `<span class="muted">0</span>` : headcount}</td>
      </tr>`;
    })
    .join("");

  const body = `
    <div class="topbar">
      <h1>Companies</h1>
      <span class="count">${companies.length}</span>
    </div>
    ${
      companies.length
        ? `<table>
          <thead><tr><th>Name</th><th>Type</th><th>People</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`
        : `<div class="empty"><h2>No companies yet</h2><p>Run <span class="mono">acrm import csv ./leads.csv</span> to add some.</p></div>`
    }
  `;
  return renderShell({ workspace, active: "companies", counts, body });
}

function renderDealsPage(workspace: string, counts: Counts): string {
  const body = `
    <div class="topbar">
      <h1>Deals</h1>
      <span class="count">${counts.deals}</span>
    </div>
    <div class="empty">
      <h2>No deals yet</h2>
      <p>Deals appear here once imported or created.</p>
    </div>
  `;
  return renderShell({ workspace, active: "deals", counts, body });
}

async function handleRequest(
  lix: Lix,
  workspaceLabel: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  if (pathname === "/") {
    res.statusCode = 302;
    res.setHeader("Location", "/people");
    res.end();
    return;
  }

  const counts = await loadCounts(lix);

  if (pathname === "/people") {
    const [people, companies] = await Promise.all([
      loadPeople(lix),
      loadCompanies(lix),
    ]);
    const companyById = new Map(
      companies.filter((c) => c.name).map((c) => [c.id, c.name as string]),
    );
    const html = renderPeoplePage(people, companyById, workspaceLabel, counts);
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
    return;
  }

  if (pathname === "/companies") {
    const [companies, people] = await Promise.all([
      loadCompanies(lix),
      loadPeople(lix),
    ]);
    const peopleByCompany = new Map<string, number>();
    for (const p of people) {
      if (!p.company_id) continue;
      peopleByCompany.set(p.company_id, (peopleByCompany.get(p.company_id) ?? 0) + 1);
    }
    const html = renderCompaniesPage(
      companies,
      peopleByCompany,
      workspaceLabel,
      counts,
    );
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
    return;
  }

  if (pathname === "/deals") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(renderDealsPage(workspaceLabel, counts));
    return;
  }

  res.statusCode = 404;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("Not found");
}

function openInBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // fine — user can click the URL
  }
}

export function startUiServer(
  lix: Lix,
  workspaceLabel: string,
  opts: { port: number; open: boolean },
): void {
  const server = createServer((req, res) => {
    handleRequest(lix, workspaceLabel, req, res).catch((err) => {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(err instanceof Error ? err.message : String(err));
    });
  });

  server.on("error", (err) => {
    fail(err.message, ERR.UI);
    process.exit(1);
  });

  const url = `http://localhost:${opts.port}`;
  server.listen(opts.port, "127.0.0.1", () => {
    process.stdout.write(`acrm ui — ${workspaceLabel}\n`);
    process.stdout.write(`  ${url}\n`);
    process.stdout.write(`  Ctrl+C to stop\n`);
    if (opts.open) openInBrowser(url);
  });

  const shutdown = async () => {
    server.close();
    try {
      await lix.close();
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export function registerUi(program: Command): void {
  program
    .command("ui")
    .description(
      "launch a basic local browser UI to validate the .acrm file (read-only; tables for people, companies, deals)",
    )
    .option("-p, --port <port>", "port to listen on", "3737")
    .option("--no-open", "do not auto-open the browser")
    .addHelpText(
      "after",
      `
This UI is intentionally minimal — just enough to eyeball that an import landed
correctly. It is read-only, has no filters, search, or edit affordances.

Claude Code is expected to extend it as needed. The implementation is a single
file (src/commands/ui.ts): a node:http server with server-rendered HTML and
inline CSS, no client framework, no build step. To add a view, filter, or
detail drawer, edit that file directly.
`,
    )
    .action(async (opts: { port: string; open: boolean }) => {
      const root = program.opts() as { json?: boolean; workspace?: string };
      setJsonMode(root.json);
      const port = Number(opts.port);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        fail(`invalid port: ${opts.port}`, ERR.INVALID_INPUT);
        process.exit(1);
      }

      let lix: Lix;
      try {
        lix = await openWorkspace({ workspace: root.workspace });
      } catch (e) {
        if (e instanceof AcrmError) fail(e.message, e.code, e.hint);
        else fail(e instanceof Error ? e.message : String(e), ERR.UI);
        process.exit(1);
      }

      const resolved = root.workspace
        ? root.workspace.endsWith(".acrm")
          ? root.workspace
          : root.workspace + ".acrm"
        : (findWorkspace() ?? "workspace.acrm");
      const workspaceLabel = path.basename(resolved);

      startUiServer(lix, workspaceLabel, { port, open: opts.open });
    });
}

