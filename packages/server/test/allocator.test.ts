// Tests for the multi-device range allocator. Key properties: across any
// sequence of leases/completions/expiries no two devices ever hold the same
// chunk, chunks tile the full range, and it scales to the real 2^71 #72 space
// without materializing a billion objects.

import { RangeAllocator } from "../src/allocator.ts";
import { PUZZLE_72 } from "../../core/src/puzzle.ts";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}

console.log("\n== scales to the real #72 range (lazy, no OOM) ==");
{
  const a = new RangeAllocator(PUZZLE_72.rangeStart, PUZZLE_72.rangeEnd, 1n << 40n);
  check("chunk count == 2^31", a.chunkCount === (1n << 31n), "got " + a.chunkCount);
  const cov = a.verifyCoverage();
  check("chunks tile the #72 range exactly (first.start, last.end, adjacency)", cov.ok, cov.reason || "");
  const c0 = a.chunkAt(0n);
  check("chunk 0 starts at range start", c0.start === PUZZLE_72.rangeStart);
  const cl = a.chunkAt(a.chunkCount - 1n);
  check("last chunk ends at range end", cl.end === PUZZLE_72.rangeEnd);
  // lease a few; indices must be distinct and bounds disjoint
  const leased = [a.lease("A"), a.lease("B"), a.lease("C")].filter(Boolean);
  check("3 leases on huge range succeed instantly", leased.length === 3);
}

console.log("\n== leases are disjoint ==");
{
  const a = new RangeAllocator(0n, 999n, 100n); // 10 chunks
  const d1 = a.lease("deviceA")!, d2 = a.lease("deviceB")!, d3 = a.lease("deviceC")!;
  check("three devices get three different chunks", d1.index !== d2.index && d2.index !== d3.index && d1.index !== d3.index);
  const chunks = [d1, d2, d3];
  let overlap = false;
  for (let i = 0; i < chunks.length; i++) for (let j = i + 1; j < chunks.length; j++)
    if (!(chunks[i].end < chunks[j].start || chunks[j].end < chunks[i].start)) overlap = true;
  check("no two assigned chunks overlap", !overlap);
}

console.log("\n== exhaustion ==");
{
  const a = new RangeAllocator(0n, 299n, 100n); // 3 chunks
  const idx = new Set<string>();
  for (let i = 0; i < 3; i++) { const c = a.lease("d" + i)!; idx.add(c.index.toString()); }
  check("3 leases return 3 distinct chunks", idx.size === 3);
  check("4th lease returns null (exhausted)", a.lease("d4") === null);
}

console.log("\n== expired lease reclaimed and reassigned (crash recovery) ==");
{
  const a = new RangeAllocator(0n, 199n, 100n, 1000); // 2 chunks, 1s lease
  const c = a.lease("flaky", 0)!;
  check("reclaim at t=2000 frees 1", a.reclaimExpired(2000) === 1);
  const c2 = a.lease("healthy", 2000)!;
  check("same chunk reassigned to healthy device", c2.index === c.index);
  check("lowest-index-first: reclaimed chunk reused before frontier", c2.index === 0n);
}

console.log("\n== completion rules ==");
{
  const a = new RangeAllocator(0n, 199n, 100n);
  const c = a.lease("owner")!;
  check("non-holder cannot complete", a.complete(c.index, "intruder") === false);
  check("holder completes", a.complete(c.index, "owner") === true);
  const s = a.summary();
  check("summary reports 1 done", s.done === 1);
  check("completed chunk is never reclaimed/re-handed", (() => {
    // force an (illegal) release attempt + reclaim; done must stay done
    a.reclaimExpired(Date.now() + 10 ** 9);
    const next = a.lease("other")!;
    return next.index !== c.index;
  })());
}

console.log("\n== randomized stress: no chunk ever held twice ==");
{
  const a = new RangeAllocator(0n, 10000n, 100n); // 101 chunks
  const held = new Map<string, bigint>();
  let now = 0, violation = false;
  for (let step = 0; step < 8000; step++) {
    now += 1;
    const dev = "dev" + (step % 7);
    const roll = Math.random();
    if (roll < 0.5 && !held.has(dev)) { const c = a.lease(dev, now); if (c) held.set(dev, c.index); }
    else if (roll < 0.7 && held.has(dev)) { a.complete(held.get(dev)!, dev); held.delete(dev); }
    else if (roll < 0.85 && held.has(dev)) { a.release(held.get(dev)!, dev); held.delete(dev); }
    else if (held.has(dev)) a.renew(held.get(dev)!, dev, undefined, now);
    // invariant check
    const seen = new Set<string>();
    for (const ac of a.activeChunks()) { const k = ac.chunk.index.toString(); if (seen.has(k)) violation = true; seen.add(k); }
  }
  check("no chunk held by two devices across 8000 random ops", !violation);
  check("coverage intact after stress", a.verifyCoverage().ok);
}

console.log("\n== serialize / deserialize round trip ==");
{
  const a = new RangeAllocator(0n, 999n, 100n);
  const x = a.lease("d1")!; a.lease("d2"); a.complete(x.index, "d1");
  const b = RangeAllocator.deserialize(a.serialize());
  check("chunkCount preserved", b.chunkCount === a.chunkCount);
  check("done count preserved", b.summary().done === 1);
  check("coverage intact after round trip", b.verifyCoverage().ok);
}

console.log(`\n==== ${passed} passed, ${failed} failed ====\n`);
process.exit(failed === 0 ? 0 : 1);
