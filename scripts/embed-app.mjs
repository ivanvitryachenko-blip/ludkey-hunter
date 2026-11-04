// Embed the built web app into the Cloudflare Worker as src/app.js, so the
// Worker serves the app itself (no static-asset layer in front of /api/*).
// Run after rebuilding the standalone app.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "packages/cloudflare/public/index.html"), "utf8");
const out =
  "// AUTO-GENERATED from packages/cloudflare/public/index.html — do not edit by hand.\n" +
  "// Regenerate: node scripts/embed-app.mjs\n" +
  "export const APP_HTML = " + JSON.stringify(html) + ";\n";
writeFileSync(join(root, "packages/cloudflare/src/app.js"), out);
console.log("embedded app -> packages/cloudflare/src/app.js (" + html.length + " bytes of HTML)");
