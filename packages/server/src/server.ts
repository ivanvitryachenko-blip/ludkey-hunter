// LudKey Hunter coordination server.
//
// Hands out non-overlapping chunks of the puzzle range to authenticated
// devices, tracks progress, and aggregates statistics. Built on Node's stdlib
// http (no framework) so it runs anywhere with zero native deps. Progress is
// persisted to a JSON file and restored on restart.
//
// Security posture (honest): bearer-token per device, found keys are stored
// ONLY in the server's local data dir and never echoed in list endpoints.
// Run it on your LAN or behind a reverse proxy with TLS — do not expose a home
// machine directly to the internet.

import http from "node:http";
import crypto from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RangeAllocator } from "./allocator.ts";
import { PUZZLE_72, getTargetHash160Hex } from "../../core/src/puzzle.ts";

interface Device { id: string; token: string; name: string; type: string; gpu?: string; createdAt: number; lastSeen: number; scanned: string; speed: number; }

// Config is read at start() time (not import time) so tests/env can set it.
let DATA_DIR = "./data";
let STATE_FILE = join(DATA_DIR, "state.json");
let MATCH_FILE = join(DATA_DIR, "FOUND_KEY.json"); // local only, never served
let CHUNK_SIZE = 1n << 25n;
let PORT = 8071;

let allocator = new RangeAllocator(PUZZLE_72.rangeStart, PUZZLE_72.rangeEnd, CHUNK_SIZE);
const devices = new Map<string, Device>();

// ---- security hardening ----
const MAX_DEVICES = 10000;
const REGISTER_WINDOW_MS = 60 * 1000;
const REGISTER_MAX_PER_IP = 20;
const MAX_BODY_BYTES = 16 * 1024;
const ipHits = new Map<string, number[]>(); // register rate limiting

const CSP = [
  "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:", "font-src 'self' data:", "connect-src 'self' https:",
  "worker-src 'self' blob:", "child-src 'self' blob:", "object-src 'none'",
  "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join("; ");
const SECURITY_HEADERS: Record<string, string> = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "geolocation=(), camera=(), microphone=(), payment=(), usb=()",
};

// Constant-time token compare (avoids length/prefix timing leaks).
function tokenEqual(a: string, b: string): boolean {
  const ab = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) { // still do a compare to keep timing flat
    crypto.timingSafeEqual(ab, ab); return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function parseChunkIndex(v: unknown, chunkCount: bigint): bigint | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v);
  if (!/^[0-9]+$/.test(s)) return null;
  let n: bigint; try { n = BigInt(s); } catch { return null; }
  if (n < 0n || n >= chunkCount) return null;
  return n;
}

function rateOkRegister(ip: string, now = Date.now()): boolean {
  const arr = (ipHits.get(ip) || []).filter((t) => now - t < REGISTER_WINDOW_MS);
  if (arr.length >= REGISTER_MAX_PER_IP) { ipHits.set(ip, arr); return false; }
  arr.push(now); ipHits.set(ip, arr);
  if (ipHits.size > 5000) for (const [k, v] of ipHits) if (!v.some((t) => now - t < REGISTER_WINDOW_MS)) ipHits.delete(k);
  return true;
}

// The web app, loaded once at startup and served at "/".
let APP_HTML = "";
function loadApp() {
  const here = dirname(fileURLToPath(import.meta.url)); // packages/server/src
  const candidates = [
    process.env.LUDKEY_APP,
    join(here, "..", "..", "..", "apps", "web-standalone", "index.html"),
    join(process.cwd(), "apps", "web-standalone", "index.html"),
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    try { if (existsSync(p)) { APP_HTML = readFileSync(p, "utf8"); return p; } } catch {}
  }
  return null;
}

function loadState() {
  if (existsSync(STATE_FILE)) {
    try {
      const o = JSON.parse(readFileSync(STATE_FILE, "utf8"));
      if (o.allocator) {
        const restored = RangeAllocator.deserialize(o.allocator);
        // Discard state from a different puzzle/range (e.g. an old #71 file) —
        // the active puzzle must start clean.
        if (restored.rangeStart === PUZZLE_72.rangeStart && restored.rangeEnd === PUZZLE_72.rangeEnd) {
          allocator = restored;
          if (o.devices) for (const d of o.devices) devices.set(d.id, d);
          console.log(`[state] restored ${devices.size} devices, ${allocator.summary().done} chunks done`);
        } else {
          console.log(`[state] stored range does not match puzzle #${PUZZLE_72.number}; starting clean`);
        }
      }
    } catch (e) { console.error("[state] restore failed:", (e as Error).message); }
  }
}
function saveState() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STATE_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify({ allocator: allocator.serialize(), devices: [...devices.values()] }));
  writeFileSync(STATE_FILE, readFileSync(tmp));
}

function auth(req: http.IncomingMessage): Device | null {
  const h = req.headers["authorization"] || "";
  const m = /^Bearer\s+(.+)$/.exec(Array.isArray(h) ? h[0] : h);
  if (!m) return null;
  for (const d of devices.values()) if (tokenEqual(d.token, m[1])) return d;
  return null;
}

function clientIp(req: http.IncomingMessage): string {
  const xf = req.headers["x-forwarded-for"];
  if (xf) return String(Array.isArray(xf) ? xf[0] : xf).split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function send(res: http.ServerResponse, code: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type", ...SECURITY_HEADERS });
  res.end(s);
}
function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = ""; let tooBig = false;
    req.on("data", (c) => {
      if (tooBig) return;
      data += c;
      if (data.length > MAX_BODY_BYTES) { tooBig = true; data = ""; } // reject oversized bodies
    });
    req.on("end", () => { if (tooBig) return resolve({}); try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost`);
  const path = url.pathname;
  if (req.method === "OPTIONS") return send(res, 204, {});

  try {
    // Serve the web app itself so every device uses one URL (same-origin API).
    if ((path === "/" || path === "/index.html") && req.method === "GET") {
      if (APP_HTML) { res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS, "content-security-policy": CSP }); return res.end(APP_HTML); }
      res.writeHead(404); return res.end("web app not found next to server");
    }

    // Public: puzzle info + aggregate status
    if (path === "/api/info" && req.method === "GET") {
      return send(res, 200, { puzzle: PUZZLE_72.number, address: PUZZLE_72.address, hash160: getTargetHash160Hex(), rangeStart: "0x" + PUZZLE_72.rangeStart.toString(16), rangeEnd: "0x" + PUZZLE_72.rangeEnd.toString(16), chunkSize: "0x" + CHUNK_SIZE.toString(16) });
    }
    if (path === "/api/status" && req.method === "GET") {
      const s = allocator.summary();
      let totalSpeed = 0; const now = Date.now();
      const devList = [...devices.values()].map((d) => { const online = now - d.lastSeen < 60000; if (online) totalSpeed += d.speed; return { id: d.id, name: d.name, type: d.type, gpu: d.gpu, online, speed: d.speed, scanned: d.scanned }; });
      return send(res, 200, { summary: { ...s, scanned: s.scanned.toString(), total: s.total.toString() }, totalSpeed, devices: devList });
    }
    // Register a new device -> returns id + token
    if (path === "/api/register" && req.method === "POST") {
      if (!rateOkRegister(clientIp(req))) return send(res, 429, { error: "rate limited" });
      if (devices.size >= MAX_DEVICES) return send(res, 429, { error: "device limit reached" });
      const b = await readBody(req);
      const id = "dev_" + crypto.randomBytes(6).toString("hex");
      const token = crypto.randomBytes(24).toString("hex");
      const d: Device = { id, token, name: String(b.name || id).slice(0, 64), type: String(b.type || "unknown").slice(0, 32), gpu: b.gpu ? String(b.gpu).slice(0, 64) : undefined, createdAt: Date.now(), lastSeen: Date.now(), scanned: "0", speed: 0 };
      devices.set(id, d); saveState();
      return send(res, 200, { deviceId: id, token });
    }

    // From here on, auth required
    const dev = auth(req);
    if (!dev) return send(res, 401, { error: "unauthorized" });
    dev.lastSeen = Date.now();

    if (path === "/api/lease" && req.method === "POST") {
      const c = allocator.lease(dev.id);
      if (!c) return send(res, 200, { chunk: null, message: "range fully assigned or done" });
      return send(res, 200, { chunk: { index: c.index.toString(), start: "0x" + c.start.toString(16), end: "0x" + c.end.toString(16) } });
    }
    if (path === "/api/heartbeat" && req.method === "POST") {
      const b = await readBody(req);
      dev.speed = Number(b.speed || 0); dev.scanned = String(b.scanned || dev.scanned).slice(0, 40);
      if (b.chunkIndex !== undefined) {
        const idx = parseChunkIndex(b.chunkIndex, allocator.chunkCount);
        if (idx === null) return send(res, 400, { error: "bad chunkIndex" });
        let sc: bigint | undefined; if (b.chunkScanned !== undefined) { try { sc = BigInt(String(b.chunkScanned)); if (sc < 0n) sc = undefined; } catch { sc = undefined; } }
        allocator.renew(idx, dev.id, sc);
      }
      return send(res, 200, { ok: true });
    }
    if (path === "/api/complete" && req.method === "POST") {
      const b = await readBody(req);
      const idx = parseChunkIndex(b.chunkIndex, allocator.chunkCount);
      if (idx === null) return send(res, 400, { error: "bad chunkIndex" });
      const ok = allocator.complete(idx, dev.id); saveState();
      return send(res, 200, { ok });
    }
    if (path === "/api/release" && req.method === "POST") {
      const b = await readBody(req);
      const idx = parseChunkIndex(b.chunkIndex, allocator.chunkCount);
      if (idx === null) return send(res, 400, { error: "bad chunkIndex" });
      const ok = allocator.release(idx, dev.id); saveState();
      return send(res, 200, { ok });
    }
    // Report a FIND — notice only. The private key is NEVER sent to or stored by
    // the coordinator; it stays on the finder's device (local file + auto-sweep).
    if (path === "/api/match" && req.method === "POST") {
      const b = await readBody(req);
      const target = getTargetHash160Hex().toLowerCase();
      if (String(b.hash160 || "").toLowerCase() !== target) return send(res, 400, { ok: false, error: "hash160 does not match target" });
      if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
      if (!existsSync(MATCH_FILE)) { // never overwrite an existing find
        writeFileSync(MATCH_FILE, JSON.stringify({ when: new Date().toISOString(), device: dev.id, hash160: target, address: PUZZLE_72.address }, null, 2));
        console.log(`\n*** MATCH reported by ${dev.id} — recorded (notice only; no private key is transmitted or stored server-side) ***\n`);
      }
      return send(res, 200, { ok: true, stored: true });
    }
    return send(res, 404, { error: "not found" });
  } catch (e) {
    return send(res, 500, { error: (e as Error).message });
  }
});

// Periodic persistence + stale-lease reclamation.
setInterval(() => { allocator.reclaimExpired(); saveState(); }, 30000).unref();

export function start() {
  DATA_DIR = process.env.LUDKEY_DATA || "./data";
  STATE_FILE = join(DATA_DIR, "state.json");
  MATCH_FILE = join(DATA_DIR, "FOUND_KEY.json");
  CHUNK_SIZE = BigInt(process.env.LUDKEY_CHUNK || (1n << 25n).toString());
  PORT = Number(process.env.PORT || 8071);
  allocator = new RangeAllocator(PUZZLE_72.rangeStart, PUZZLE_72.rangeEnd, CHUNK_SIZE);
  loadState();
  const appPath = loadApp();
  server.listen(PORT, () => {
    console.log(`LudKey Hunter server on http://localhost:${PORT}  (puzzle #${PUZZLE_72.number}, chunk 0x${CHUNK_SIZE.toString(16)})`);
    console.log(appPath ? `  serving the web app at /  (open http://<this-host>:${PORT}/ on your devices)` : `  (web app not found; API only)`);
  });
}

// Run when invoked directly.
if (process.argv[1] && process.argv[1].endsWith("server.ts")) start();
