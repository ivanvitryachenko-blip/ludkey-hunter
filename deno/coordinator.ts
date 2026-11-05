// LudKey Hunter — cloud coordinator for Deno Deploy (free, always-on, with
// built-in persistent Deno KV). Serves the web app AND coordinates a shared
// search across all your devices over ONE https://*.deno.dev URL — useful where
// Cloudflare's *.workers.dev domain is blocked by an ISP.
//
// Puzzle #72, random 2^25 segments, same REST API as the Cloudflare coordinator.
// Each device gets a different RANDOM unclaimed segment; no two devices get the
// same one (atomic Deno-KV claim). Leases auto-expire via KV TTL.
//
// Deploy (free): see deno/README.md — create a Deno Deploy project from this
// GitHub repo, entrypoint deno/coordinator.ts. You get one HTTPS URL.

import { APP_HTML } from "./app.ts";

// ---- Puzzle #72 (checksum-verified in the core) ----
const PUZZLE = {
  number: 72,
  address: "1JTK7s9YVYywfm5XUH7RNhHJH1LshCaRFR",
  hash160: "bf7413e8df4e7a34ce9dc13e2f2648783ec54adb",
  rangeStart: 1n << 71n,
  rangeEnd: (1n << 72n) - 1n,
};
const KEYSPACE = PUZZLE.rangeEnd - PUZZLE.rangeStart + 1n; // 2^71
const CHUNK_SIZE = (() => {
  try { const v = (globalThis as any).Deno?.env.get("LUDKEY_CHUNK"); if (v) return BigInt(v); } catch { /* ignore */ }
  return 1n << 25n; // 2^25 keys per segment
})();
const CHUNK_COUNT = (KEYSPACE + CHUNK_SIZE - 1n) / CHUNK_SIZE; // 2^46
const LEASE_MS = 10 * 60 * 1000;

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-max-age": "86400" };
const CSP = [
  "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:", "font-src 'self' data:", "connect-src 'self' https:",
  "worker-src 'self' blob:", "child-src 'self' blob:", "object-src 'none'",
  "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join("; ");
const SECURITY_HEADERS = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "geolocation=(), camera=(), microphone=(), payment=(), usb=()",
};
const enc = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...CORS, ...SECURITY_HEADERS } });
const hex = (x: bigint) => "0x" + x.toString(16);

// Abuse limits + helpers (mirror of the Cloudflare worker).
const MAX_DEVICES = 10000;
const REGISTER_WINDOW_MS = 60 * 1000;
const REGISTER_MAX_PER_IP = 20;
const MAX_BODY_BYTES = 16 * 1024;
const ipHits = new Map<string, number[]>();

function rateOkRegister(ip: string, now = Date.now()): boolean {
  const arr = (ipHits.get(ip) || []).filter((t) => now - t < REGISTER_WINDOW_MS);
  if (arr.length >= REGISTER_MAX_PER_IP) { ipHits.set(ip, arr); return false; }
  arr.push(now); ipHits.set(ip, arr);
  if (ipHits.size > 5000) for (const [k, v] of ipHits) if (!v.some((t) => now - t < REGISTER_WINDOW_MS)) ipHits.delete(k);
  return true;
}
function timingSafeEqual(a: string, b: string): boolean {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= ((a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0));
  return diff === 0;
}
function parseChunkIndex(v: unknown, chunkCount: bigint): bigint | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v);
  if (!/^[0-9]+$/.test(s)) return null;
  let n: bigint; try { n = BigInt(s); } catch { return null; }
  if (n < 0n || n >= chunkCount) return null;
  return n;
}
async function readBody(req: Request): Promise<any> {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > MAX_BODY_BYTES) return {};
  try { const t = await req.text(); if (t.length > MAX_BODY_BYTES) return {}; return t ? JSON.parse(t) : {}; } catch { return {}; }
}
function clientIp(req: Request, info?: any): string {
  const xf = req.headers.get("x-forwarded-for");
  if (xf) return xf.split(",")[0].trim();
  try { return info?.remoteAddr?.hostname || "unknown"; } catch { return "unknown"; }
}

let _kv: any = null;
async function kv() { if (!_kv) _kv = await (globalThis as any).Deno.openKv(); return _kv; }

function chunkBounds(idx: bigint) {
  const s = PUZZLE.rangeStart + idx * CHUNK_SIZE;
  let e = s + CHUNK_SIZE - 1n; if (e > PUZZLE.rangeEnd) e = PUZZLE.rangeEnd;
  return { start: s, end: e };
}

function randBelow(n: bigint): bigint {
  const a = new Uint32Array(3); crypto.getRandomValues(a);
  const r = (BigInt(a[0]) << 64n) | (BigInt(a[1]) << 32n) | BigInt(a[2]);
  return r % n;
}

async function readDeviceId(req: Request): Promise<string | null> {
  const h = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/.exec(h); if (!m) return null;
  const db = await kv();
  const dev = await db.get(["token", m[1]]);
  // Deno KV lookup is already an exact-match on the key; the token itself is a
  // 192-bit random value, so there is no useful timing oracle here. We keep the
  // constant-time helper available for any in-memory comparisons.
  return dev.value ? (dev.value as string) : null;
}
void timingSafeEqual;

// Hand out a RANDOM unclaimed segment. Atomic claim prevents two devices from
// getting the same one. Active leases carry a TTL so a crashed device's segment
// frees itself.
async function lease(deviceId: string): Promise<{ index: bigint; start: bigint; end: bigint } | null> {
  const db = await kv();
  const now = Date.now();
  for (let i = 0; i < 64; i++) {
    const idx = randBelow(CHUNK_COUNT);
    const key = idx.toString();
    const done = await db.get(["done", key]);
    if (done.value) continue;
    const active = await db.get(["active", key]);
    if (active.value && (active.value as any).until > now) continue;
    const res = await db.atomic()
      .check(done)   // done unchanged (still absent)
      .check(active) // active unchanged (absent or the expired one we read)
      .set(["active", key], { deviceId, until: now + LEASE_MS }, { expireIn: LEASE_MS + 120000 })
      .commit();
    if (res.ok) return { index: idx, ...chunkBounds(idx) };
  }
  return null;
}

async function handler(req: Request, info?: any): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if ((path === "/" || path === "/index.html") && req.method === "GET") {
    return new Response(APP_HTML, { headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS, "content-security-policy": CSP } });
  }

  if (path === "/api/info" && req.method === "GET") {
    return enc({ puzzle: PUZZLE.number, address: PUZZLE.address, hash160: PUZZLE.hash160, rangeStart: hex(PUZZLE.rangeStart), rangeEnd: hex(PUZZLE.rangeEnd), chunkSize: hex(CHUNK_SIZE), worker: "ok" });
  }

  const db = await kv();

  if (path === "/api/status" && req.method === "GET") {
    const now = Date.now();
    const devices: any[] = [];
    let totalSpeed = 0;
    for await (const e of db.list({ prefix: ["dev"] })) {
      const d = e.value as any; const online = now - d.lastSeen < 60000;
      if (online) totalSpeed += d.speed || 0;
      devices.push({ id: d.id, name: d.name, type: d.type, online, speed: d.speed || 0, scanned: String(d.scanned || 0) });
    }
    let assigned = 0;
    for await (const e of db.list({ prefix: ["active"] })) { if ((e.value as any).until > now) assigned++; }
    const doneCount = Number(((await db.get(["doneCount"])).value as any) ?? 0n);
    const doneScanned = (((await db.get(["doneScanned"])).value as any) ?? 0n) as bigint;
    const scanned = BigInt(doneScanned);
    const percent = KEYSPACE > 0n ? Number((scanned * 1000000n) / KEYSPACE) / 10000 : 0;
    return enc({ summary: { chunkCount: CHUNK_COUNT.toString(), done: doneCount, assigned, pending: (CHUNK_COUNT - BigInt(doneCount) - BigInt(assigned)).toString(), scanned: scanned.toString(), total: KEYSPACE.toString(), percent }, totalSpeed, devices });
  }

  if (path === "/api/register" && req.method === "POST") {
    if (!rateOkRegister(clientIp(req, info))) return enc({ error: "rate limited" }, 429);
    let devCount = 0; for await (const _ of db.list({ prefix: ["dev"] })) { if (++devCount >= MAX_DEVICES) break; }
    if (devCount >= MAX_DEVICES) return enc({ error: "device limit reached" }, 429);
    const b = await readBody(req);
    const id = "dev_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const token = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");
    await db.set(["token", token], id);
    await db.set(["dev", id], { id, name: String(b.name || id).slice(0, 64), type: String(b.type || "unknown").slice(0, 32), lastSeen: Date.now(), speed: 0, scanned: 0 });
    return enc({ deviceId: id, token });
  }

  const deviceId = await readDeviceId(req);
  if (!deviceId) return enc({ error: "unauthorized" }, 401);

  if (path === "/api/lease" && req.method === "POST") {
    const c = await lease(deviceId);
    if (!c) return enc({ chunk: null, message: "range fully assigned/done" });
    return enc({ chunk: { index: c.index.toString(), start: hex(c.start), end: hex(c.end) } });
  }
  if (path === "/api/heartbeat" && req.method === "POST") {
    const b = await readBody(req);
    const d = (await db.get(["dev", deviceId])).value as any;
    if (d) { d.lastSeen = Date.now(); if (b.speed !== undefined) d.speed = Number(b.speed || 0); if (b.scanned !== undefined) d.scanned = Number(b.scanned || d.scanned); await db.set(["dev", deviceId], d); }
    if (b.chunkIndex !== undefined) {
      const idx = parseChunkIndex(b.chunkIndex, CHUNK_COUNT);
      if (idx === null) return enc({ error: "bad chunkIndex" }, 400);
      const a = await db.get(["active", idx.toString()]); if (a.value && (a.value as any).deviceId === deviceId) await db.set(["active", idx.toString()], { deviceId, until: Date.now() + LEASE_MS }, { expireIn: LEASE_MS + 120000 });
    }
    return enc({ ok: true });
  }
  if (path === "/api/complete" && req.method === "POST") {
    const b = await readBody(req);
    const idx = parseChunkIndex(b.chunkIndex, CHUNK_COUNT);
    if (idx === null) return enc({ error: "bad chunkIndex" }, 400);
    const key = idx.toString();
    const a = await db.get(["active", key]);
    if (!a.value || (a.value as any).deviceId !== deviceId) return enc({ ok: false });
    const already = await db.get(["done", key]);
    const Deno = (globalThis as any).Deno;
    let at = db.atomic().check(a).delete(["active", key]);
    if (!already.value) {
      const { start, end } = chunkBounds(BigInt(key));
      at = at.set(["done", key], deviceId)
        .mutate({ type: "sum", key: ["doneCount"], value: new Deno.KvU64(1n) })
        .mutate({ type: "sum", key: ["doneScanned"], value: new Deno.KvU64(end - start + 1n) });
    }
    const res = await at.commit();
    return enc({ ok: res.ok });
  }
  if (path === "/api/release" && req.method === "POST") {
    const b = await readBody(req);
    const idx = parseChunkIndex(b.chunkIndex, CHUNK_COUNT);
    if (idx === null) return enc({ error: "bad chunkIndex" }, 400);
    const key = idx.toString();
    const a = await db.get(["active", key]);
    if (a.value && (a.value as any).deviceId === deviceId) await db.atomic().check(a).delete(["active", key]).commit();
    return enc({ ok: true });
  }
  if (path === "/api/match" && req.method === "POST") {
    const b = await readBody(req);
    // Integrity: only a report matching the real target is accepted.
    if (String(b.hash160 || "").toLowerCase() !== PUZZLE.hash160) return enc({ ok: false, error: "hash160 does not match target" }, 400);
    // SECURITY: the private key is NEVER accepted or stored server-side; only a
    // non-secret notice is recorded, and an existing one is never overwritten.
    const existing = await db.get(["FOUND"]);
    if (!existing.value) await db.set(["FOUND"], { when: new Date().toISOString(), device: deviceId, hash160: PUZZLE.hash160, address: PUZZLE.address });
    return enc({ ok: true, stored: true });
  }
  return enc({ error: "not found" }, 404);
}

if (typeof (globalThis as any).Deno !== "undefined" && (globalThis as any).Deno.serve) {
  (globalThis as any).Deno.serve(handler);
}

export { handler, lease, chunkBounds, CHUNK_SIZE, CHUNK_COUNT, PUZZLE };
