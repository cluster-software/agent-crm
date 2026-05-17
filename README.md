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

`@agent-crm/cli` pins `@agent-crm/sdk` to an exact version (the
`updateInternalDependencies` setting in `.changeset/config.json` keeps
the pin in sync on every release). Don't run `npm publish` by hand —
`.github/workflows/release.yml` runs `changeset publish` after the
"chore: version packages" PR merges, and that's the only path that
guarantees the SDK lands on the registry before the CLI version that
depends on it.
