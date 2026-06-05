<div align="center">

<img src="https://cdn.shopify.com/s/files/1/0748/5902/0324/files/acrm_3db956bc-2fc0-4339-81b0-27a1e14d7e58.png?v=1780243666" alt="agent-crm">

</div>

<br />

<div align="center" style="margin:24px 0;">
  <a href="https://getcluster.ai" style="display:inline-block; margin-right:8px; text-decoration:none; outline:none; border:none;">
    <img src="https://cdn.shopify.com/s/files/1/0748/5902/0324/files/download_0dff1946-6eea-4433-a53f-f6f562442834.png?v=1779414386" alt="Download for macOS" height="45">
  </a>
</div>

<br />

Let Claude run sales for you. Claude needs a source of truth but existing CRMs
are too hard for Claude to work with. Their MCPs torch your context window,
every action is a network round-trip, and you blow through your usage limits.

Solution: Agent CRM. Headless, scriptable, with a CLI for Claude to interact
with.

```txt
                    ┌──────────────┐
                    │  Custom UIs  │
                    └──────┬───────┘
                           │
┌────────────┐      ┌──────▼──────┐      ┌───────────────┐
│ AI Agents  ├─────►│ REST / CLI  │◄─────┤ App / Scripts │
└────────────┘      └─────────────┘      └───────────────┘
```

## Install

Download the macOS app from [getcluster.ai](https://getcluster.ai), or install
the CLI:

```sh
npm install -g @agent-crm/cli
```

## Packages

- CLI: https://www.npmjs.com/package/@agent-crm/cli
- SDK: https://www.npmjs.com/package/@agent-crm/sdk

## Maintenance

New Agent CRM code, releases, and deployments are managed from the current
Agent CRM monorepo. This repository no longer publishes CLI or SDK releases.
