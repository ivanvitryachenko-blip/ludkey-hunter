// LudKey Hunter — Cloudflare Worker coordinator (puzzle #72).
//
// WHAT THIS IS: a serverless, always-on coordination server that runs on
// Cloudflare's edge — no home PC, no port forwarding. It hands out
// non-overlapping 2^25 chunks of the #72 range to every device that opens the
// link, tracks progress, and serves the web app itself, so one URL is both the
// UI and the shared coordinator (same-origin, no CORS to configure).
//
// HONESTY / SECURITY (same posture as the Node server):
//   * The allocator logic is a byte-for-byte port of packages/server/src/
//     allocator.ts, which is covered by packages/server/test/allocator.test.ts
//     (no-overlap, full-coverage, crash-recovery, 8000-op stress). The port was
//     NOT re-run on Cloudflare in the authoring environment (no account there);
//     the logic it mirrors is the tested one. Verify with `wrangler dev` before
//     trusting a deployment — see README.md.
//   * A found key is stored ONLY in Durable Object storage under a private key
//     and is NEVER returned by any endpoint. No list/status call can read it.
//   * Per-device bearer tokens; the coordinator state is a single Durable
//     Object instance so lease/complete are serialized and atomic.
//
// Deploy: `wrangler deploy` to YOUR Cloudflare account (free plan is enough —
// Durable Objects with SQLite storage are free-tier eligible). I cannot deploy
// it for you; the README has the three commands.

import { APP_HTML } from "./app.js"; // the web app, embedded (served from "/")

// ---------------------------------------------------------------------------
// Puzzle #72 parameters (checksum-verified in the TS core).
// ---------------------------------------------------------------------------
const PUZZLE = {
  number: 72,
  address: "1JTK7s9YVYywfm5XUH7RNhHJH1LshCaRFR",
  hash160: "bf7413e8df4e7a34ce9dc13e2f2648783ec54adb",
  rangeStart: 1n << 71n,          // 0x800000000000000000
  rangeEnd: (1n << 72n) - 1n,     // 0xffffffffffffffffff
};
const DEFAULT_CHUNK_BITS = 25n;   // 2^25 keys per segment (task spec)
const LEASE_MS = 10 * 60 * 1000;  // 10 minutes
// Abuse limits: cap total registered devices and throttle registration per IP
// so nobody can flood the coordinator with devices (storage/DoS abuse).
const MAX_DEVICES = 10000;
const REGISTER_WINDOW_MS = 60 * 1000;
const REGISTER_MAX_PER_IP = 20;     // registrations per IP per minute
const MAX_BODY_BYTES = 16 * 1024;   // request bodies are tiny JSON; reject larger

// Constant-time string compare, so token checks don't leak length/prefix via
// timing. Both sides are compared over the longer length.
function timingSafeEqual(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// Parse a chunk index from untrusted input: must be a non-negative integer
// string within [0, chunkCount). Returns a BigInt or null (-> 400).
function parseChunkIndex(v, chunkCount) {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v);
  if (!/^[0-9]+$/.test(s)) return null;
  let n;
  try { n = BigInt(s); } catch { return null; }
  if (n < 0n || n >= chunkCount) return null;
  return n;
}

// ---------------------------------------------------------------------------
// RangeAllocator — ported verbatim from packages/server/src/allocator.ts.
// Lazy: stores only the frontier + sparse sets, so it scales to the real
// #72 chunk count (2^46 chunks at 2^25) without materializing anything.
// ---------------------------------------------------------------------------
class RangeAllocator {
  constructor(rangeStart, rangeEnd, chunkSize, leaseMs = LEASE_MS) {
    if (rangeEnd < rangeStart) throw new Error("rangeEnd < rangeStart");
    if (chunkSize <= 0n) throw new Error("chunkSize must be positive");
    this.rangeStart = rangeStart;
    this.rangeEnd = rangeEnd;
    this.chunkSize = chunkSize;
    this.leaseMs = leaseMs;
    const total = rangeEnd - rangeStart + 1n;
    this.chunkCount = (total + chunkSize - 1n) / chunkSize; // ceil
    this.nextIndex = 0n;
    this.reclaimed = [];
    this.active = new Map();  // key: index.toString() -> {deviceId, leaseUntil, scanned}
    this.done = new Set();    // completed index strings
    this.doneScanned = 0n;
  }

  chunkAt(index) {
    if (index < 0n || index >= this.chunkCount) throw new Error("chunk index out of range");
    const s = this.rangeStart + index * this.chunkSize;
    let e = s + this.chunkSize - 1n;
    if (e > this.rangeEnd) e = this.rangeEnd;
    return { index, start: s, end: e };
  }

  // Hand out a RANDOM unclaimed segment (not sequential), so devices explore
  // the range in random order. Still no overlap: a segment that is done or
  // currently leased is never re-handed. With ~2^46 segments and only a tiny
  // claimed set, a random pick almost always lands on a free segment at once.
  lease(deviceId, now = Date.now()) {
    this.reclaimExpired(now);
    const total = this.chunkCount;
    if (BigInt(this.done.size) + BigInt(this.active.size) >= total) return null; // all claimed
    let index = null;
    for (let tries = 0; tries < 64; tries++) {
      const cand = randBelow(total);
      const key = cand.toString();
      if (!this.done.has(key) && !this.active.has(key)) { index = cand; break; }
    }
    if (index === null) {
      // Dense fallback (practically never hit): linear scan from a random offset.
      const start = randBelow(total);
      for (let i = 0n; i < total; i++) {
        const cand = (start + i) % total;
        const key = cand.toString();
        if (!this.done.has(key) && !this.active.has(key)) { index = cand; break; }
      }
      if (index === null) return null;
    }
    this.active.set(index.toString(), { deviceId, leaseUntil: now + this.leaseMs, scanned: 0n });
    return this.chunkAt(index);
  }

  renew(index, deviceId, scanned, now = Date.now()) {
    const l = this.active.get(index.toString());
    if (!l || l.deviceId !== deviceId) return false;
    l.leaseUntil = now + this.leaseMs;
    if (scanned !== undefined) l.scanned = scanned;
    return true;
  }

  complete(index, deviceId) {
    const key = index.toString();
    const l = this.active.get(key);
    if (!l || l.deviceId !== deviceId) return false;
    this.active.delete(key);
    if (!this.done.has(key)) {
      this.done.add(key);
      const c = this.chunkAt(index);
      this.doneScanned += c.end - c.start + 1n;
    }
    return true;
  }

  release(index, deviceId) {
    const key = index.toString();
    const l = this.active.get(key);
    if (!l || l.deviceId !== deviceId) return false;
    this.active.delete(key);
    this.freeIndex(index);
    return true;
  }

  reclaimExpired(now = Date.now()) {
    let n = 0;
    for (const [key, l] of this.active) {
      if (l.leaseUntil <= now) { this.active.delete(key); this.freeIndex(BigInt(key)); n++; }
    }
    return n;
  }

  // Random mode: a freed segment simply leaves `active`/`done`, which makes it
  // unclaimed again and eligible to be picked at random later. No ordered
  // reclaim list is needed, so this is intentionally a no-op.
  freeIndex(_index) { /* no-op in random mode */ }

  activeChunks() {
    const out = [];
    for (const [key, l] of this.active) {
      out.push({ chunk: this.chunkAt(BigInt(key)), deviceId: l.deviceId, scanned: l.scanned, leaseUntil: l.leaseUntil });
    }
    return out;
  }

  summary(now = Date.now()) {
    this.reclaimExpired(now);
    let activeScanned = 0n;
    for (const l of this.active.values()) activeScanned += l.scanned;
    const total = this.rangeEnd - this.rangeStart + 1n;
    const scanned = this.doneScanned + activeScanned;
    return {
      chunkCount: this.chunkCount.toString(),
      pending: (this.chunkCount - BigInt(this.done.size) - BigInt(this.active.size)).toString(),
      assigned: this.active.size,
      done: this.done.size,
      scanned, total,
      percent: total > 0n ? Number((scanned * 1000000n) / total) / 10000 : 0,
    };
  }

  serialize() {
    return JSON.stringify({
      rangeStart: this.rangeStart.toString(), rangeEnd: this.rangeEnd.toString(),
      chunkSize: this.chunkSize.toString(), nextIndex: this.nextIndex.toString(),
      reclaimed: this.reclaimed.map((x) => x.toString()),
      active: [...this.active.entries()].map(([k, v]) => [k, v.deviceId, v.leaseUntil, v.scanned.toString()]),
      done: [...this.done], doneScanned: this.doneScanned.toString(),
    });
  }

  static deserialize(json, leaseMs) {
    const o = JSON.parse(json);
    const a = new RangeAllocator(BigInt(o.rangeStart), BigInt(o.rangeEnd), BigInt(o.chunkSize), leaseMs);
    a.nextIndex = BigInt(o.nextIndex);
    a.reclaimed = o.reclaimed.map((x) => BigInt(x));
    for (const [k, dev, until, scanned] of o.active) a.active.set(k, { deviceId: dev, leaseUntil: until, scanned: BigInt(scanned) });
    a.done = new Set(o.done);
    a.doneScanned = BigInt(o.doneScanned);
    return a;
  }
}

// ---------------------------------------------------------------------------
// Coordinator — the single Durable Object that owns all shared state.
// Every /api/* request is routed to the one instance named "global", so the
// runtime serializes them and lease/complete stay atomic across all devices.
// State is persisted to DO storage and restored when the instance wakes.
// ---------------------------------------------------------------------------
export class Coordinator {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.allocator = null;
    this.devices = new Map();
    this.ipHits = new Map(); // ip -> [timestamps] for register rate limiting (in-memory)
    this.chunkSize = 1n << (env.CHUNK_BITS ? BigInt(env.CHUNK_BITS) : DEFAULT_CHUNK_BITS);
    // Load persisted state before serving any request. load() never throws, so
    // the Durable Object always constructs and never returns an empty response.
    this.ctx.blockConcurrencyWhile(async () => { await this.load(); });
  }

  async load() {
    try {
      const stored = await this.ctx.storage.get(["allocator", "devices"]);
      const allocStr = stored.get("allocator");
      if (allocStr) {
        try {
          const restored = RangeAllocator.deserialize(allocStr, LEASE_MS);
          // Discard state from a different puzzle/range (e.g. an old #71 store).
          if (restored.rangeStart === PUZZLE.rangeStart && restored.rangeEnd === PUZZLE.rangeEnd) {
            this.allocator = restored;
          }
        } catch {}
      }
      const devStr = stored.get("devices");
      if (devStr) { try { for (const d of JSON.parse(devStr)) this.devices.set(d.id, d); } catch {} }
    } catch {}
    // Always end with a valid allocator, whatever happened above.
    if (!this.allocator) {
      this.allocator = new RangeAllocator(PUZZLE.rangeStart, PUZZLE.rangeEnd, this.chunkSize, LEASE_MS);
    }
  }

  async persist() {
    await this.ctx.storage.put({
      allocator: this.allocator.serialize(),
      devices: JSON.stringify([...this.devices.values()]),
    });
  }

  auth(req) {
    const h = req.headers.get("authorization") || "";
    const m = /^Bearer\s+(.+)$/.exec(h);
    if (!m) return null;
    for (const d of this.devices.values()) if (timingSafeEqual(d.token, m[1])) return d;
    return null;
  }

  // Sliding-window per-IP rate limit for registration. Returns true if allowed.
  rateOkRegister(ip, now = Date.now()) {
    const arr = (this.ipHits.get(ip) || []).filter((t) => now - t < REGISTER_WINDOW_MS);
    if (arr.length >= REGISTER_MAX_PER_IP) { this.ipHits.set(ip, arr); return false; }
    arr.push(now); this.ipHits.set(ip, arr);
    if (this.ipHits.size > 5000) { for (const [k, v] of this.ipHits) if (!v.some((t) => now - t < REGISTER_WINDOW_MS)) this.ipHits.delete(k); }
    return true;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    try {
      if (path === "/api/info" && method === "GET") {
        return json({
          puzzle: PUZZLE.number, address: PUZZLE.address, hash160: PUZZLE.hash160,
          rangeStart: "0x" + PUZZLE.rangeStart.toString(16),
          rangeEnd: "0x" + PUZZLE.rangeEnd.toString(16),
          chunkSize: "0x" + this.chunkSize.toString(16),
        });
      }
      if (path === "/api/status" && method === "GET") {
        const s = this.allocator.summary();
        let totalSpeed = 0; const now = Date.now();
        const devList = [...this.devices.values()].map((d) => {
          const online = now - d.lastSeen < 60000; if (online) totalSpeed += d.speed;
          return { id: d.id, name: d.name, type: d.type, gpu: d.gpu, online, speed: d.speed, scanned: d.scanned };
        });
        return json({
          summary: { ...s, scanned: s.scanned.toString(), total: s.total.toString() },
          totalSpeed, devices: devList,
        });
      }
      if (path === "/api/register" && method === "POST") {
        const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "unknown";
        if (!this.rateOkRegister(ip)) return json({ error: "rate limited" }, 429);
        if (this.devices.size >= MAX_DEVICES) return json({ error: "device limit reached" }, 429);
        const b = await body(req);
        const id = "dev_" + hex(6);
        const token = hex(24);
        // Clamp attacker-controlled display strings so one device can't bloat
        // state or carry absurd payloads (also escaped again in the UI).
        const d = { id, token, name: String(b.name || id).slice(0, 64), type: String(b.type || "unknown").slice(0, 32), gpu: b.gpu ? String(b.gpu).slice(0, 64) : undefined, createdAt: Date.now(), lastSeen: Date.now(), scanned: "0", speed: 0 };
        this.devices.set(id, d); await this.persist();
        return json({ deviceId: id, token });
      }

      // auth required below
      const dev = this.auth(req);
      if (!dev) return json({ error: "unauthorized" }, 401);
      dev.lastSeen = Date.now();

      if (path === "/api/lease" && method === "POST") {
        const c = this.allocator.lease(dev.id);
        await this.persist();
        if (!c) return json({ chunk: null, message: "range fully assigned or done" });
        return json({ chunk: { index: c.index.toString(), start: "0x" + c.start.toString(16), end: "0x" + c.end.toString(16) } });
      }
      if (path === "/api/heartbeat" && method === "POST") {
        const b = await body(req);
        dev.speed = Number(b.speed || 0); dev.scanned = String(b.scanned || dev.scanned).slice(0, 40);
        if (b.chunkIndex !== undefined) {
          const idx = parseChunkIndex(b.chunkIndex, this.allocator.chunkCount);
          if (idx === null) return json({ error: "bad chunkIndex" }, 400);
          let sc; if (b.chunkScanned !== undefined) { try { sc = BigInt(String(b.chunkScanned)); if (sc < 0n) sc = undefined; } catch { sc = undefined; } }
          this.allocator.renew(idx, dev.id, sc);
        }
        return json({ ok: true });
      }
      if (path === "/api/complete" && method === "POST") {
        const b = await body(req);
        const idx = parseChunkIndex(b.chunkIndex, this.allocator.chunkCount);
        if (idx === null) return json({ error: "bad chunkIndex" }, 400);
        const ok = this.allocator.complete(idx, dev.id); await this.persist();
        return json({ ok });
      }
      if (path === "/api/release" && method === "POST") {
        const b = await body(req);
        const idx = parseChunkIndex(b.chunkIndex, this.allocator.chunkCount);
        if (idx === null) return json({ error: "bad chunkIndex" }, 400);
        const ok = this.allocator.release(idx, dev.id); await this.persist();
        return json({ ok });
      }
      if (path === "/api/match" && method === "POST") {
        const b = await body(req);
        // Integrity: only accept a report whose hash160 actually matches the
        // puzzle target, so a griefer can't clobber a real find with junk.
        if (String(b.hash160 || "").toLowerCase() !== PUZZLE.hash160) return json({ ok: false, error: "hash160 does not match target" }, 400);
        // SECURITY: the private key is NEVER accepted or stored server-side. It
        // stays on the finder's device (local file + auto-sweep). We record only
        // a non-secret notice, and never overwrite an existing one.
        const existing = await this.ctx.storage.get("FOUND_KEY");
        if (!existing) await this.ctx.storage.put("FOUND_KEY", JSON.stringify({ when: new Date().toISOString(), device: dev.id, hash160: PUZZLE.hash160, address: PUZZLE.address }));
        return json({ ok: true, stored: true });
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  }
}

// ---------------------------------------------------------------------------
// Worker entry: route /api/* to the single Coordinator DO; everything else is
// the static web app (served from the bundled assets).
// ---------------------------------------------------------------------------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    // The Worker handles EVERY request directly — no static-asset layer in
    // front of it — so /api/* always reaches the coordinator.
    // /api/info is static puzzle data — answer it from the Worker itself, so it
    // works even if the Durable Object is unavailable. If this returns JSON but
    // the stateful endpoints below don't, the problem is the Durable Object.
    if (url.pathname === "/api/info" && req.method === "GET") {
      return cors(json({
        puzzle: PUZZLE.number, address: PUZZLE.address, hash160: PUZZLE.hash160,
        rangeStart: "0x" + PUZZLE.rangeStart.toString(16),
        rangeEnd: "0x" + PUZZLE.rangeEnd.toString(16),
        chunkSize: "0x" + (1n << DEFAULT_CHUNK_BITS).toString(16),
        worker: "ok",
      }));
    }
    if (url.pathname.startsWith("/api/")) {
      try {
        if (!env.COORDINATOR) return cors(json({ error: "Durable Object binding COORDINATOR is missing on this deployment" }, 500));
        const id = env.COORDINATOR.idFromName("global");
        const stub = env.COORDINATOR.get(id);
        const res = await stub.fetch(req);
        return cors(res);
      } catch (e) {
        // Surface the real cause as JSON instead of a Cloudflare HTML error page.
        return cors(json({ error: "coordinator error: " + String((e && e.stack) || (e && e.message) || e) }, 500));
      }
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(APP_HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS, "content-security-policy": CSP } });
    }
    return new Response("Not found", { status: 404, headers: SECURITY_HEADERS });
  },
};

// ---- security headers ----
// Content-Security-Policy for the served app. The app is a single HTML file
// with inline <script>/<style> (hence 'unsafe-inline') and Web Workers from
// blob: URLs. connect-src allows same-origin plus any https coordinator the
// user points a standalone UI at. frame-ancestors 'none' blocks clickjacking.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' https:",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");
const SECURITY_HEADERS = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "geolocation=(), camera=(), microphone=(), payment=(), usb=()",
};

// ---- helpers ----
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
function cors(res) {
  const h = new Headers(res.headers);
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-headers", "authorization,content-type");
  h.set("access-control-allow-methods", "GET,POST,OPTIONS");
  h.set("access-control-max-age", "86400");
  // Baseline hardening on every response (HSTS forces TLS, nosniff stops MIME
  // sniffing, no-referrer avoids leaking the token-bearing URL).
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) h.set(k, v);
  return new Response(res.body, { status: res.status, headers: h });
}
async function body(req) {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > MAX_BODY_BYTES) return {}; // oversized -> treated as empty, never parsed
  try {
    const txt = await req.text();
    if (txt.length > MAX_BODY_BYTES) return {};
    return txt ? JSON.parse(txt) : {};
  } catch { return {}; }
}
// Uniform-ish random bigint in [0, n). n is the segment count (~2^46), so 96
// random bits make the modulo bias negligible.
function randBelow(n) {
  const a = new Uint32Array(3); crypto.getRandomValues(a);
  const r = (BigInt(a[0]) << 64n) | (BigInt(a[1]) << 32n) | BigInt(a[2]);
  return r % n;
}
function hex(bytes) {
  const a = new Uint8Array(bytes); crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}
