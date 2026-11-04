// LudKey Hunter — cloud coordinator for Deno Deploy (free, always-on, with
// built-in persistent Deno KV). Serves the web app AND coordinates a shared
// search across all your devices: each device is handed a different,
// non-overlapping chunk, and progress is combined.
//
// Deploy (free): see deno/README.md. In short — push this repo to GitHub (done),
// create a free project on Deno Deploy from the repo, set the entrypoint to
// `deno/coordinator.ts`, and enable KV. You get one HTTPS URL; open it on your
// phone and computers, choose Mode "Connected", press Start.
//
// NOTE: this file was not executed in the authoring environment (no Deno here).
// Its REST contract mirrors the tested Node coordinator in packages/server.

// ---- Puzzle #71 (fixed, checksum-verified in the core) ----
const PUZZLE = {
  number: 71,
  address: "1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU",
  hash160: "f6f5431d25bbf7b12e8add9af5e3475c44a0a5b8",
  rangeStart: 1n << 70n,
  rangeEnd: (1n << 71n) - 1n,
};
const KEYSPACE = PUZZLE.rangeEnd - PUZZLE.rangeStart + 1n; // 2^70

// Chunk size: default 2^24 (~16.7M keys) so even a phone finishes a chunk in a
// few minutes; override with the LUDKEY_CHUNK env var (number of keys).
const CHUNK_SIZE = (() => {
  try { const v = (globalThis as any).Deno?.env.get("LUDKEY_CHUNK"); if (v) return BigInt(v); } catch { /* ignore */ }
  return 1n << 24n;
})();
const CHUNK_COUNT = (KEYSPACE + CHUNK_SIZE - 1n) / CHUNK_SIZE;
const LEASE_MS = 15 * 60 * 1000; // a chunk not completed within 15 min can be re-handed

const enc = (o: unknown) => new Response(JSON.stringify(o), {
  headers: { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST,OPTIONS" },
});
const hex = (x: bigint) => "0x" + x.toString(16);

let _kv: any = null;
async function kv() { if (!_kv) _kv = await (globalThis as any).Deno.openKv(); return _kv; }

function chunkBounds(idx: bigint) {
  const s = PUZZLE.rangeStart + idx * CHUNK_SIZE;
  let e = s + CHUNK_SIZE - 1n; if (e > PUZZLE.rangeEnd) e = PUZZLE.rangeEnd;
  return { start: s, end: e };
}

async function readToken(req: Request): Promise<string | null> {
  const h = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/.exec(h); if (!m) return null;
  const db = await kv();
  const dev = await db.get(["token", m[1]]);
  return dev.value ? (dev.value as string) : null;
}

// Monotonic, race-free lease: optimistic-concurrency bump of a counter, plus a
// small pool of expired-lease indices to re-hand. One index -> one device.
async function lease(deviceId: string): Promise<{ index: bigint; start: bigint; end: bigint } | null> {
  const db = await kv();
  // first, try to reclaim an expired lease
  const now = Date.now();
  for await (const entry of db.list({ prefix: ["active"] })) {
    const v = entry.value as { deviceId: string; until: number };
    if (v.until <= now) {
      const idx = BigInt(entry.key[1] as string);
      const res = await db.atomic().check(entry).set(["active", entry.key[1]], { deviceId, until: now + LEASE_MS }).commit();
      if (res.ok) return { index: idx, ...chunkBounds(idx) };
    }
  }
  // otherwise take the next fresh index
  for (let attempt = 0; attempt < 16; attempt++) {
    const cur = await db.get(["nextIndex"]);
    const idx = (cur.value as bigint) ?? 0n;
    if (idx >= CHUNK_COUNT) return null;
    const res = await db.atomic().check(cur)
      .set(["nextIndex"], idx + 1n)
      .set(["active", idx.toString()], { deviceId, until: now + LEASE_MS })
      .commit();
    if (res.ok) return { index: idx, ...chunkBounds(idx) };
  }
  return null;
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST,OPTIONS" } });

  // Serve the web app (one URL for every device, same-origin API).
  if ((path === "/" || path === "/index.html") && req.method === "GET") {
    try {
      const html = await (globalThis as any).Deno.readTextFile(new URL("../index.html", import.meta.url));
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    } catch { return new Response("app not found", { status: 404 }); }
  }

  const db = await kv();

  if (path === "/api/info" && req.method === "GET") {
    return enc({ puzzle: PUZZLE.number, address: PUZZLE.address, hash160: PUZZLE.hash160, rangeStart: hex(PUZZLE.rangeStart), rangeEnd: hex(PUZZLE.rangeEnd), chunkSize: hex(CHUNK_SIZE) });
  }

  if (path === "/api/status" && req.method === "GET") {
    const now = Date.now();
    const devices: any[] = [];
    let totalSpeed = 0;
    for await (const e of db.list({ prefix: ["dev"] })) {
      const d = e.value as any; const online = now - d.lastSeen < 60000;
      if (online) totalSpeed += d.speed || 0;
      devices.push({ id: d.id, name: d.name, type: d.type, online, speed: d.speed || 0, scanned: String(d.scanned || 0) });
    }
    const doneCount = (await db.get(["doneCount"])).value as bigint ?? 0n;
    const doneScanned = (await db.get(["doneScanned"])).value as bigint ?? 0n;
    const percent = Number(doneScanned) / Number(KEYSPACE) * 100;
    return enc({ summary: { chunkCount: CHUNK_COUNT.toString(), done: Number(doneCount), scanned: doneScanned.toString(), total: KEYSPACE.toString(), percent }, totalSpeed, devices });
  }

  if (path === "/api/register" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    const id = "dev_" + crypto.randomUUID().slice(0, 12);
    const token = crypto.randomUUID() + crypto.randomUUID();
    await db.set(["token", token], id);
    await db.set(["dev", id], { id, name: String(b.name || id), type: String(b.type || "unknown"), lastSeen: Date.now(), speed: 0, scanned: 0 });
    return enc({ deviceId: id, token });
  }

  const deviceId = await readToken(req);
  if (!deviceId) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });

  if (path === "/api/lease" && req.method === "POST") {
    const c = await lease(deviceId);
    if (!c) return enc({ chunk: null, message: "range fully assigned/done" });
    return enc({ chunk: { index: c.index.toString(), start: hex(c.start), end: hex(c.end) } });
  }
  if (path === "/api/heartbeat" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    const d = (await db.get(["dev", deviceId])).value as any;
    if (d) { d.lastSeen = Date.now(); d.speed = Number(b.speed || 0); d.scanned = Number(b.scanned || d.scanned); await db.set(["dev", deviceId], d); }
    if (b.chunkIndex !== undefined) { const a = await db.get(["active", String(b.chunkIndex)]); if (a.value && (a.value as any).deviceId === deviceId) await db.set(["active", String(b.chunkIndex)], { deviceId, until: Date.now() + LEASE_MS }); }
    return enc({ ok: true });
  }
  if (path === "/api/complete" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    const key = String(b.chunkIndex);
    const a = await db.get(["active", key]);
    if (!a.value || (a.value as any).deviceId !== deviceId) return enc({ ok: false });
    const already = await db.get(["done", key]);
    const at = db.atomic().check(a).delete(["active", key]);
    if (!already.value) { at.set(["done", key], deviceId).sum(["doneCount"], 1n).mutate({ type: "sum", key: ["doneScanned"], value: new (globalThis as any).Deno.KvU64(0n) }); }
    // doneScanned increment handled below (KvU64 can't take bigint chunk directly if > u64; chunk fits in u64)
    const res = await at.commit();
    if (res.ok && !already.value) {
      const { start, end } = chunkBounds(BigInt(key));
      await db.atomic().mutate({ type: "sum", key: ["doneScanned"], value: new (globalThis as any).Deno.KvU64(end - start + 1n) }).commit();
    }
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
    // deliberately never returned by /api/status
    return enc({ ok: true, stored: true });
  }
  return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
}

// Deno Deploy entrypoint. Guarded so the file can also be imported in non-Deno
// tooling without side effects.
if (typeof (globalThis as any).Deno !== "undefined" && (globalThis as any).Deno.serve) {
  (globalThis as any).Deno.serve(handler);
}

export { handler, lease, chunkBounds, CHUNK_SIZE, CHUNK_COUNT };
