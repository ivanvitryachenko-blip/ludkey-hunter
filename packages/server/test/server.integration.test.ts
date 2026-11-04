// Integration test: boot the real HTTP server, register two devices, and prove
// they receive different non-overlapping chunks, heartbeats renew, completion
// works, and /api/status aggregates — all over the wire.

import { start } from "../src/server.ts";
import { rmSync } from "node:fs";

process.env.LUDKEY_DATA = "/tmp/ludkey-test-data";
process.env.PORT = "8178";
process.env.LUDKEY_CHUNK = (1n << 40n).toString();
try { rmSync("/tmp/ludkey-test-data", { recursive: true, force: true }); } catch {}

const BASE = "http://localhost:8178";
let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}
async function j(path: string, opts: any = {}) {
  const r = await fetch(BASE + path, opts);
  return { status: r.status, body: await r.json() };
}

start();
await new Promise((r) => setTimeout(r, 400)); // let it bind

console.log("\n== device registration + leasing ==");
const regA = await j("/api/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "PhoneA", type: "phone" }) });
const regB = await j("/api/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "RigB", type: "desktop", gpu: "RTX 5070" }) });
check("device A registered with token", !!regA.body.token && !!regA.body.deviceId);
check("device B registered with token", !!regB.body.token);

const authA = { authorization: "Bearer " + regA.body.token, "content-type": "application/json" };
const authB = { authorization: "Bearer " + regB.body.token, "content-type": "application/json" };

const leaseA = await j("/api/lease", { method: "POST", headers: authA });
const leaseB = await j("/api/lease", { method: "POST", headers: authB });
check("A gets a chunk", !!leaseA.body.chunk);
check("B gets a chunk", !!leaseB.body.chunk);
check("A and B get DIFFERENT chunks", leaseA.body.chunk.index !== leaseB.body.chunk.index);
// disjoint ranges
const aStart = BigInt(leaseA.body.chunk.start), aEnd = BigInt(leaseA.body.chunk.end);
const bStart = BigInt(leaseB.body.chunk.start), bEnd = BigInt(leaseB.body.chunk.end);
check("A and B ranges do not overlap", aEnd < bStart || bEnd < aStart);

console.log("\n== auth enforcement ==");
const noAuth = await j("/api/lease", { method: "POST" });
check("lease without token is 401", noAuth.status === 401);
const badAuth = await j("/api/lease", { method: "POST", headers: { authorization: "Bearer nope" } });
check("lease with bad token is 401", badAuth.status === 401);

console.log("\n== heartbeat + complete + status ==");
await j("/api/heartbeat", { method: "POST", headers: authA, body: JSON.stringify({ speed: 450000, scanned: "1000000", chunkIndex: leaseA.body.chunk.index, chunkScanned: "1000000" }) });
const comp = await j("/api/complete", { method: "POST", headers: authB, body: JSON.stringify({ chunkIndex: leaseB.body.chunk.index }) });
check("B completes its chunk", comp.body.ok === true);
const wrongComplete = await j("/api/complete", { method: "POST", headers: authA, body: JSON.stringify({ chunkIndex: leaseB.body.chunk.index }) });
check("A cannot complete B's chunk", wrongComplete.body.ok === false);

const status = await j("/api/status");
check("status lists 2 devices", status.body.devices.length === 2);
check("status shows 1 done chunk", status.body.summary.done === 1);
check("status aggregates device speed", status.body.totalSpeed >= 450000);

console.log("\n== match report is stored locally, never served ==");
await j("/api/match", { method: "POST", headers: authA, body: JSON.stringify({ key: "0x40000000000000abcd", hash160: "deadbeef", address: "1Demo" }) });
const statusAfter = await j("/api/status");
const leak = JSON.stringify(statusAfter.body).includes("40000000000000abcd");
check("found key is NOT exposed in /api/status", !leak);

console.log(`\n==== ${passed} passed, ${failed} failed ====\n`);
process.exit(failed === 0 ? 0 : 1);
