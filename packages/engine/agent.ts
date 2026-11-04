// LudKey Hunter compute agent (Node/CPU reference).
//
// Connects to the coordination server, leases non-overlapping chunks, searches
// them with the tested CpuEngine, sends heartbeats, completes chunks, and
// reports any match. This is the portable reference agent; the native Windows
// CUDA agent (packages/agent-cuda) speaks the same protocol but computes on GPU.
//
// Usage: node --experimental-strip-types agent.ts --server http://host:8071 [--name myrig] [--window 2048]

import { CpuEngine } from "./src/cpuEngine.ts";
import { SpeedTracker, fmtSpeed } from "./src/stats.ts";
import { saveCheckpoint, loadCheckpoint } from "./src/checkpoint.ts";
import { bytesToHex, pointToAddressCompressed } from "../core/src/address.ts";
import { scalarMulG } from "../core/src/secp256k1.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

function arg(n: string, d?: string) { const i = process.argv.indexOf("--" + n); return i >= 0 ? process.argv[i + 1] : d; }
const SERVER = arg("server", "http://localhost:8071")!;
const NAME = arg("name", "node-agent-" + Math.random().toString(16).slice(2, 6))!;
const WINDOW = Number(arg("window", "2048"));
const CRED = arg("cred", "./agent-cred.json")!;
const RUN_SECONDS = Number(arg("seconds", "0")); // 0 = run forever
const PAYOUT = arg("payout") || process.env.LUDKEY_PAYOUT;       // your address to auto-sweep to
const DO_BROADCAST = process.argv.includes("--broadcast");

async function api(path: string, token: string | null, body?: unknown) {
  const r = await fetch(SERVER + path, {
    method: body ? "POST" : (path === "/api/info" || path === "/api/status" ? "GET" : "POST"),
    headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

async function register(): Promise<{ id: string; token: string }> {
  if (existsSync(CRED)) { try { return JSON.parse(readFileSync(CRED, "utf8")); } catch {} }
  const info = await fetch(SERVER + "/api/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: NAME, type: "desktop", gpu: "CPU reference" }) });
  const { deviceId, token } = await info.json();
  const cred = { id: deviceId, token };
  writeFileSync(CRED, JSON.stringify(cred));
  return cred;
}

async function main() {
  const info = await api("/api/info", null);
  const target = hexToBytes(info.hash160);
  console.log(`Agent "${NAME}" -> ${SERVER}  (puzzle #${info.puzzle}, target ${info.hash160})`);
  const cred = await register();
  console.log(`Registered as ${cred.id}`);

  const t0 = Date.now();
  while (true) {
    if (RUN_SECONDS && (Date.now() - t0) / 1000 >= RUN_SECONDS) { console.log("time limit reached, exiting"); return; }
    const lease = await api("/api/lease", cred.token, {});
    if (!lease.chunk) { console.log("no chunks available:", lease.message); return; }
    const idx = lease.chunk.index;
    const start = BigInt(lease.chunk.start), end = BigInt(lease.chunk.end);
    console.log(`\nLeased chunk #${idx}: ${lease.chunk.start} .. ${lease.chunk.end}`);

    // resume within-chunk progress if we have a local checkpoint for it
    const cpPath = `./chunk-${idx}.json`;
    const cp = loadCheckpoint(cpPath);
    const startFrom = cp && BigInt(cp.rangeStart) === start ? BigInt(cp.position) : start;

    const eng = new CpuEngine({ rangeStart: start, rangeEnd: end, target, windowSize: WINDOW, compressed: true, startFrom });
    const tracker = new SpeedTracker();
    let lastBeat = 0, baseScanned = cp ? Number(cp.scanned) : 0, matched = false;

    while (!eng.done) {
      if (RUN_SECONDS && (Date.now() - t0) / 1000 >= RUN_SECONDS) {
        // graceful: release the chunk so another device can take it
        await api("/api/release", cred.token, { chunkIndex: idx });
        console.log("\ntime limit reached mid-chunk; released chunk");
        return;
      }
      const found = eng.step();
      const now = Date.now();
      if (found) {
        matched = true;
        const addr = pointToAddressCompressed(scalarMulG(found.key));
        console.log(`\n*** MATCH key=0x${found.key.toString(16)} addr=${addr} ***`);
        await api("/api/match", cred.token, { key: "0x" + found.key.toString(16), hash160: bytesToHex(found.hash160), address: addr });
        writeFileSync(`./FOUND_${cred.id}.json`, JSON.stringify({ key: "0x" + found.key.toString(16), address: addr }, null, 2));
        if (PAYOUT) {
          try { const { claim } = await import("../claim/src/claim.ts"); await claim(found.key, { destAddress: PAYOUT, broadcast: DO_BROADCAST }); }
          catch (e) { console.log("claim error:", (e as Error).message, "- key saved locally, import manually."); }
        }
        return;
      }
      if (now - lastBeat >= 2000) {
        tracker.update(baseScanned + Number(eng.scanned));
        const sp = tracker.snapshot();
        await api("/api/heartbeat", cred.token, { speed: Math.round(sp.avg), scanned: String(sp.total), chunkIndex: idx, chunkScanned: String(eng.scanned) });
        saveCheckpoint(cpPath, { puzzle: info.puzzle, rangeStart: "0x" + start.toString(16), rangeEnd: "0x" + end.toString(16), position: "0x" + eng.position.toString(16), scanned: String(baseScanned + Number(eng.scanned)), compressed: true, updatedAt: new Date().toISOString() });
        process.stdout.write(`\r  ${fmtSpeed(sp.avg)} | chunk scanned ${Number(eng.scanned).toLocaleString()}   `);
        lastBeat = now;
      }
    }
    if (!matched) { await api("/api/complete", cred.token, { chunkIndex: idx }); console.log(`\nchunk #${idx} complete`); }
  }
}

function hexToBytes(h: string) { h = h.replace(/^0x/, ""); const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; }

main().catch((e) => { console.error("agent error:", e.message); process.exit(1); });
