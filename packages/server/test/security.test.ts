// Security hardening tests: boot the real HTTP server and prove the defensive
// measures added in the security audit actually work over the wire —
// security headers, registration rate limiting, strict input validation, and
// the match endpoint that records a find WITHOUT ever accepting a private key.
//
// Also unit-tests the web app's esc() helper (extracted from the shipped HTML)
// to prove stored-XSS payloads in device names/types are neutralised.

import { start } from "../src/server.ts";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getTargetHash160Hex } from "../../core/src/puzzle.ts";

process.env.LUDKEY_DATA = "/tmp/ludkey-sec-data";
process.env.PORT = "8179";
process.env.LUDKEY_CHUNK = (1n << 40n).toString();
try { rmSync("/tmp/ludkey-sec-data", { recursive: true, force: true }); } catch {}

const BASE = "http://localhost:8179";
const MATCH_FILE = "/tmp/ludkey-sec-data/FOUND_KEY.json";
const TARGET = getTargetHash160Hex();
let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}

start();
await new Promise((r) => setTimeout(r, 400));

// ---- 1. security headers ----
console.log("\n== security headers ==");
{
  const r = await fetch(BASE + "/");
  const csp = r.headers.get("content-security-policy") || "";
  check("HTML sets Content-Security-Policy", csp.includes("default-src 'self'"));
  check("CSP blocks framing (frame-ancestors none)", csp.includes("frame-ancestors 'none'"));
  check("HTML sets HSTS", (r.headers.get("strict-transport-security") || "").includes("max-age="));
  check("HTML sets X-Frame-Options: DENY", r.headers.get("x-frame-options") === "DENY");
  check("HTML sets X-Content-Type-Options: nosniff", r.headers.get("x-content-type-options") === "nosniff");
  check("HTML sets Referrer-Policy: no-referrer", r.headers.get("referrer-policy") === "no-referrer");
  await r.text();
}
{
  const r = await fetch(BASE + "/api/info");
  check("API sets HSTS", (r.headers.get("strict-transport-security") || "").includes("max-age="));
  check("API sets nosniff", r.headers.get("x-content-type-options") === "nosniff");
  await r.json();
}

// ---- 2. a device for the validation/match tests ----
async function register(name = "sec", type = "test") {
  const r = await fetch(BASE + "/api/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, type }) });
  return { status: r.status, body: await r.json() };
}
const dev = await register();
const auth = { authorization: "Bearer " + dev.body.token, "content-type": "application/json" };
async function post(path: string, obj: any, headers: any = auth) {
  const r = await fetch(BASE + path, { method: "POST", headers, body: JSON.stringify(obj) });
  return { status: r.status, body: await r.json() };
}

// ---- 3. input validation ----
console.log("\n== input validation ==");
check("complete rejects non-numeric chunkIndex (400)", (await post("/api/complete", { chunkIndex: "abc" })).status === 400);
check("complete rejects negative chunkIndex (400)", (await post("/api/complete", { chunkIndex: "-1" })).status === 400);
check("complete rejects out-of-range chunkIndex (400)", (await post("/api/complete", { chunkIndex: "99999999999999999999999999" })).status === 400);
check("complete rejects object injection (400)", (await post("/api/complete", { chunkIndex: { evil: 1 } })).status === 400);
check("heartbeat rejects bad chunkIndex (400)", (await post("/api/heartbeat", { chunkIndex: "x" })).status === 400);

// ---- 4. match: never accepts/stores a private key ----
console.log("\n== match endpoint: no private key is ever stored ==");
const wrong = await post("/api/match", { hash160: "00".repeat(20), key: "0xdeadbeef", address: "x" });
check("match with wrong hash160 is rejected (400)", wrong.status === 400);
check("no FOUND file written for a wrong report", !existsSync(MATCH_FILE));

const good = await post("/api/match", { hash160: TARGET, key: "0xCAFEBABE_SECRET_KEY", address: "1JTK7s9YVYywfm5XUH7RNhHJH1LshCaRFR" });
check("match with correct hash160 is accepted", good.status === 200 && good.body.stored === true);
check("FOUND file now exists", existsSync(MATCH_FILE));
const stored = existsSync(MATCH_FILE) ? readFileSync(MATCH_FILE, "utf8") : "";
check("stored find contains NO 'key' field", !/"key"/.test(stored) && !/CAFEBABE/.test(stored));
check("stored find records the non-secret notice", stored.includes(TARGET));

// existing find is never overwritten by a later report
const second = await post("/api/match", { hash160: TARGET, key: "0xOTHER", address: "y" });
check("second match does not overwrite the first", readFileSync(MATCH_FILE, "utf8") === stored);

// ---- 5. registration rate limiting ----
console.log("\n== registration rate limiting ==");
let got429 = false;
for (let i = 0; i < 30; i++) { const r = await register("flood" + i); if (r.status === 429) { got429 = true; break; } }
check("register is rate-limited from one IP (429)", got429);

// ---- 6. esc() neutralises stored-XSS payloads (extracted from shipped HTML) ----
console.log("\n== web app esc() XSS neutralisation ==");
{
  const here = dirname(fileURLToPath(import.meta.url));
  const html = readFileSync(join(here, "..", "..", "..", "apps", "web-standalone", "index.html"), "utf8");
  const m = html.match(/function esc\(s\)\{.*\}/); // esc is a single line
  check("esc() helper is present in the shipped app", !!m);
  if (m) {
    // eslint-disable-next-line no-new-func
    const esc = new Function("return (" + m[0].replace(/^function esc/, "function") + ")")();
    const payload = '<img src=x onerror="alert(1)">';
    const out = esc(payload);
    check("esc() removes angle brackets", !out.includes("<") && !out.includes(">"));
    check("esc() escapes quotes", !out.includes('"') || out.includes("&quot;"));
    check("esc() escapes the payload fully", out === "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  }
}

console.log(`\n==== ${passed} passed, ${failed} failed ====`);
process.exit(failed === 0 ? 0 : 1);
