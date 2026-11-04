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
import { PUZZLE_71, getTargetHash160Hex } from "../../core/src/puzzle.ts";

interface Device { id: string; token: string; name: string; type: string; gpu?: string; createdAt: number; lastSeen: number; scanned: string; speed: number; }

// Config is read at start() time (not import time) so tests/env can set it.
let DATA_DIR = "./data";
let STATE_FILE = join(DATA_DIR, "state.json");
let MATCH_FILE = join(DATA_DIR, "FOUND_KEY.json"); // local only, never served
let CHUNK_SIZE = 1n << 40n;
let PORT = 8071;

let allocator = new RangeAllocator(PUZZLE_71.rangeStart, PUZZLE_71.rangeEnd, CHUNK_SIZE);
const devices = new Map<string, Device>();

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
      if (o.allocator) allocator = RangeAllocator.deserialize(o.allocator);
      if (o.devices) for (const d of o.devices) devices.set(d.id, d);
      console.log(`[state] restored ${devices.size} devices, ${allocator.summary().done} chunks done`);
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
  for (const d of devices.values()) if (d.token === m[1]) return d;
  return null;
}

function send(res: http.ServerResponse, code: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type" });
  res.end(s);
}
function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = ""; req.on("data", (c) => (data += c)); req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost`);
  const path = url.pathname;
  if (req.method === "OPTIONS") return send(res, 204, {});

  try {
    // Serve the web app itself so every device uses one URL (same-origin API).
    if ((path === "/" || path === "/index.html") && req.method === "GET") {
      if (APP_HTML) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(APP_HTML); }
      res.writeHead(404); return res.end("web app not found next to server");
    }

    // Public: puzzle info + aggregate status
    if (path === "/api/info" && req.method === "GET") {
      return send(res, 200, { puzzle: PUZZLE_71.number, address: PUZZLE_71.address, hash160: getTargetHash160Hex(), rangeStart: "0x" + PUZZLE_71.rangeStart.toString(16), rangeEnd: "0x" + PUZZLE_71.rangeEnd.toString(16), chunkSize: "0x" + CHUNK_SIZE.toString(16) });
    }
    if (path === "/api/status" && req.method === "GET") {
      const s = allocator.summary();
      let totalSpeed = 0; const now = Date.now();
      const devList = [...devices.values()].map((d) => { const online = now - d.lastSeen < 60000; if (online) totalSpeed += d.speed; return { id: d.id, name: d.name, type: d.type, gpu: d.gpu, online, speed: d.speed, scanned: d.scanned }; });
      return send(res, 200, { summary: { ...s, scanned: s.scanned.toString(), total: s.total.toString() }, totalSpeed, devices: devList });
    }
    // Register a new device -> returns id + token
    if (path === "/api/register" && req.method === "POST") {
      const b = await readBody(req);
      const id = "dev_" + crypto.randomBytes(6).toString("hex");
      const token = crypto.randomBytes(24).toString("hex");
      const d: Device = { id, token, name: String(b.name || id), type: String(b.type || "unknown"), gpu: b.gpu ? String(b.gpu) : undefined, createdAt: Date.now(), lastSeen: Date.now(), scanned: "0", speed: 0 };
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
      dev.speed = Number(b.speed || 0); dev.scanned = String(b.scanned || dev.scanned);
      if (b.chunkIndex !== undefined) allocator.renew(BigInt(b.chunkIndex), dev.id, b.chunkScanned !== undefined ? BigInt(b.chunkScanned) : undefined);
      return send(res, 200, { ok: true });
    }
    if (path === "/api/complete" && req.method === "POST") {
      const b = await readBody(req);
      const ok = allocator.complete(BigInt(b.chunkIndex), dev.id); saveState();
      return send(res, 200, { ok });
    }
    if (path === "/api/release" && req.method === "POST") {
      const b = await readBody(req);
      const ok = allocator.release(BigInt(b.chunkIndex), dev.id); saveState();
      return send(res, 200, { ok });
    }
    // Report a found key — stored LOCALLY only, never returned by any endpoint.
    if (path === "/api/match" && req.method === "POST") {
      const b = await readBody(req);
      if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(MATCH_FILE, JSON.stringify({ when: new Date().toISOString(), device: dev.id, key: b.key, hash160: b.hash160, address: b.address }, null, 2));
      console.log(`\n*** MATCH reported by ${dev.id} — saved to ${MATCH_FILE} (NOT served over the network) ***\n`);
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
  CHUNK_SIZE = BigInt(process.env.LUDKEY_CHUNK || (1n << 40n).toString());
  PORT = Number(process.env.PORT || 8071);
  allocator = new RangeAllocator(PUZZLE_71.rangeStart, PUZZLE_71.rangeEnd, CHUNK_SIZE);
  loadState();
  const appPath = loadApp();
  server.listen(PORT, () => {
    console.log(`LudKey Hunter server on http://localhost:${PORT}  (puzzle #${PUZZLE_71.number}, chunk 0x${CHUNK_SIZE.toString(16)})`);
    console.log(appPath ? `  serving the web app at /  (open http://<this-host>:${PORT}/ on your devices)` : `  (web app not found; API only)`);
  });
}

// Run when invoked directly.
if (process.argv[1] && process.argv[1].endsWith("server.ts")) start();
