// npm postinstall bootstrap.
//
// Two responsibilities:
//   1. Silently no-op if dist/ doesn't exist yet (fresh git clone before
//      `npm run build` — npm install would otherwise fail).
//   2. Catch any error from the real installer so npm install never aborts.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const target = path.join(
  __dirname,
  "..",
  "dist",
  "scripts",
  "install-skills.js",
);

if (!fs.existsSync(target)) {
  // Pre-build state. The published tarball always contains dist/, so this
  // branch only fires on dev clones — fine to skip silently.
  process.exit(0);
}

import(target).catch((err) => {
  process.stderr.write(
    "acrm: skills install crashed (continuing) — " +
      (err && err.message ? err.message : String(err)) +
      "\n",
  );
  process.exit(0);
});
