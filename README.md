# agent-crm

Headless CRM for Claude Code. A portable `.acrm` file your agent can query, edit, diff, and version.

This repo is a monorepo containing two packages:

- **[`@agent-crm/cli`](packages/cli/)** — the `acrm` command-line tool. End users install this.
- **[`@agent-crm/sdk`](packages/sdk/)** — the programmatic API the CLI is built on. Other surfaces (Electron, MCP server, automation) consume this directly.

See [`packages/cli/README.md`](packages/cli/README.md) for installation, usage, and docs.

## Development

```bash
npm install        # installs all workspaces and links them together
npm run build      # builds every package
npm test           # runs every package's tests
npm run dev        # runs the CLI from source (tsx)
```

Release flow uses [changesets](https://github.com/changesets/changesets):

```bash
npx changeset      # describe the change
git commit -am "feat: ..."
git push           # CI opens a release PR; merging it publishes to npm
```

### First-publish bootstrap (one time)

`@agent-crm/cli` pins `@agent-crm/sdk` to an exact version, so the first
CLI release that references a given SDK version requires that SDK to
already be on the npm registry. Bootstrap once with:

```bash
npm run build
cd packages/sdk && npm publish --access public   # SDK must land first
cd ../cli       && npm publish --access public
```

After this one-time step, never run `npm publish` by hand —
`changeset publish` in CI (`.github/workflows/release.yml`) handles
ordering on every subsequent release.
