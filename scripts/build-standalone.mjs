// Build the standalone / GitHub-Pages HTML from the artifact source.
// The artifact version (apps/web-standalone/index.html) has no <!doctype>,
// <head> or viewport meta because the Claude Artifact runtime injects those at
// publish time. When the same file is served by GitHub Pages or opened directly,
// it needs a real HTML skeleton — above all the viewport meta, without which
// phones render the page zoomed-out at a desktop width. This wraps the content
// with that skeleton (and the base reset the runtime normally provides).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "apps/web-standalone/index.html"), "utf8");

const titleMatch = src.match(/<title>([^<]*)<\/title>/);
const title = titleMatch ? titleMatch[1] : "LudKey Hunter";

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' https:; worker-src 'self' blob:; child-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0a0c10">
<meta name="description" content="LudKey Hunter — Bitcoin Puzzle #71 research engine. Runs in your browser on phone or computer.">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230a0c10'/%3E%3Ccircle cx='16' cy='16' r='6' fill='%23f7931a'/%3E%3C/svg%3E">
<style>
  html { color-scheme: dark; -webkit-text-size-adjust: 100%; }
  :root { padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }
  body { margin: 0; font: 14px system-ui, -apple-system, sans-serif; background: #0a0c10; }
  img { max-width: 100%; }
  [hidden] { display: none !important; }
</style>
<title>${title}</title>
</head>
<body>
${src}
</body>
</html>
`;

// The content still carries its own <title> near the top; a second <title> in
// the body is harmless (browsers keep the head one). Remove the Claude-only
// meta tag that means nothing outside the runtime.
const out = html.replace('<meta name="claude:viewport-fit-sides" content="cover">', "");

writeFileSync(join(root, "index.html"), out);
writeFileSync(join(root, "apps/web-standalone/standalone.html"), out);
console.log("built standalone -> index.html (" + out.length + " bytes)");
