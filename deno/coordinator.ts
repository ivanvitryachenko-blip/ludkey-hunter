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

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST,OPTIONS" };
const enc = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...CORS } });
const hex = (x: bigint) => "0x" + x.toString(16);

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
  return dev.value ? (dev.value as string) : null;
}

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

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if ((path === "/" || path === "/index.html") && req.method === "GET") {
    return new Response(APP_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
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
    const b = await req.json().catch(() => ({}));
    const id = "dev_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const token = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");
    await db.set(["token", token], id);
    await db.set(["dev", id], { id, name: String(b.name || id), type: String(b.type || "unknown"), lastSeen: Date.now(), speed: 0, scanned: 0 });
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
    const b = await req.json().catch(() => ({}));
    const d = (await db.get(["dev", deviceId])).value as any;
    if (d) { d.lastSeen = Date.now(); if (b.speed !== undefined) d.speed = Number(b.speed || 0); if (b.scanned !== undefined) d.scanned = Number(b.scanned || d.scanned); await db.set(["dev", deviceId], d); }
    if (b.chunkIndex !== undefined) { const a = await db.get(["active", String(b.chunkIndex)]); if (a.value && (a.value as any).deviceId === deviceId) await db.set(["active", String(b.chunkIndex)], { deviceId, until: Date.now() + LEASE_MS }, { expireIn: LEASE_MS + 120000 }); }
    return enc({ ok: true });
  }
  if (path === "/api/complete" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    const key = String(b.chunkIndex);
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
    const b = await req.json().catch(() => ({}));
    const key = String(b.chunkIndex);
    const a = await db.get(["active", key]);
    if (a.value && (a.value as any).deviceId === deviceId) await db.atomic().check(a).delete(["active", key]).commit();
    return enc({ ok: true });
  }
  if (path === "/api/match" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    await db.set(["FOUND"], { when: new Date().toISOString(), device: deviceId, key: b.key, hash160: b.hash160, address: b.address });
    return enc({ ok: true, stored: true });
  }
  return enc({ error: "not found" }, 404);
}

if (typeof (globalThis as any).Deno !== "undefined" && (globalThis as any).Deno.serve) {
  (globalThis as any).Deno.serve(handler);
}

export { handler, lease, chunkBounds, CHUNK_SIZE, CHUNK_COUNT, PUZZLE };
