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

  lease(deviceId, now = Date.now()) {
    this.reclaimExpired(now);
    let index;
    if (this.reclaimed.length > 0) {
      index = this.reclaimed.shift();
    } else if (this.nextIndex < this.chunkCount) {
      index = this.nextIndex;
      this.nextIndex += 1n;
    } else {
      return null;
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

  freeIndex(index) {
    if (this.done.has(index.toString())) return;
    let lo = 0, hi = this.reclaimed.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.reclaimed[mid] < index) lo = mid + 1; else hi = mid; }
    if (this.reclaimed[lo] !== index) this.reclaimed.splice(lo, 0, index);
  }

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
      pending: (this.chunkCount - this.nextIndex + BigInt(this.reclaimed.length)).toString(),
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
    this.chunkSize = 1n << (env.CHUNK_BITS ? BigInt(env.CHUNK_BITS) : DEFAULT_CHUNK_BITS);
    // Load persisted state before serving any request.
    this.ctx.blockConcurrencyWhile(async () => { await this.load(); });
  }

  async load() {
    const stored = await this.ctx.storage.get(["allocator", "devices"]);
    const allocStr = stored.get("allocator");
    if (allocStr) {
      const restored = RangeAllocator.deserialize(allocStr, LEASE_MS);
      // Discard state from a different puzzle/range (e.g. an old #71 store).
      if (restored.rangeStart === PUZZLE.rangeStart && restored.rangeEnd === PUZZLE.rangeEnd) {
        this.allocator = restored;
      }
    }
    if (!this.allocator) {
      this.allocator = new RangeAllocator(PUZZLE.rangeStart, PUZZLE.rangeEnd, this.chunkSize, LEASE_MS);
    }
    const devStr = stored.get("devices");
    if (devStr) { try { for (const d of JSON.parse(devStr)) this.devices.set(d.id, d); } catch {} }
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
    for (const d of this.devices.values()) if (d.token === m[1]) return d;
    return null;
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
        const b = await body(req);
        const id = "dev_" + hex(6);
        const token = hex(24);
        const d = { id, token, name: String(b.name || id), type: String(b.type || "unknown"), gpu: b.gpu ? String(b.gpu) : undefined, createdAt: Date.now(), lastSeen: Date.now(), scanned: "0", speed: 0 };
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
        dev.speed = Number(b.speed || 0); dev.scanned = String(b.scanned || dev.scanned);
        if (b.chunkIndex !== undefined) this.allocator.renew(BigInt(b.chunkIndex), dev.id, b.chunkScanned !== undefined ? BigInt(b.chunkScanned) : undefined);
        return json({ ok: true });
      }
      if (path === "/api/complete" && method === "POST") {
        const b = await body(req);
        const ok = this.allocator.complete(BigInt(b.chunkIndex), dev.id); await this.persist();
        return json({ ok });
      }
      if (path === "/api/release" && method === "POST") {
        const b = await body(req);
        const ok = this.allocator.release(BigInt(b.chunkIndex), dev.id); await this.persist();
        return json({ ok });
      }
      if (path === "/api/match" && method === "POST") {
        const b = await body(req);
        // Stored ONLY in private DO storage; never returned by any endpoint.
        await this.ctx.storage.put("FOUND_KEY", JSON.stringify({ when: new Date().toISOString(), device: dev.id, key: b.key, hash160: b.hash160, address: b.address }));
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
    if (url.pathname.startsWith("/api/")) {
      const id = env.COORDINATOR.idFromName("global");
      const stub = env.COORDINATOR.get(id);
      const res = await stub.fetch(req);
      return cors(res);
    }
    // Static assets (the web app). Configured via [assets] in wrangler.toml.
    if (env.ASSETS) return env.ASSETS.fetch(req);
    return new Response("web app not bundled; set [assets] directory in wrangler.toml", { status: 404 });
  },
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
  return new Response(res.body, { status: res.status, headers: h });
}
async function body(req) { try { return await req.json(); } catch { return {}; } }
function hex(bytes) {
  const a = new Uint8Array(bytes); crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}
