// End-to-end proof that the search engine actually FINDS a known key.
// We hide a known key inside a small range, hand the engine only the target
// hash160, and require it to recover the exact key. This exercises EC math,
// hashing, address pipeline, batch windows, and off-by-one boundaries together.

import { CpuEngine } from "../src/cpuEngine.ts";
import { scalarMulG, compressedPubkey, uncompressedPubkey } from "../../core/src/secp256k1.ts";
import { sha256 } from "../../core/src/sha256.ts";
import { ripemd160 } from "../../core/src/ripemd160.ts";
import { bytesToHex } from "../../core/src/address.ts";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}

function targetFor(key: bigint, compressed: boolean): Uint8Array {
  const p = scalarMulG(key);
  const pub = compressed ? compressedPubkey(p) : uncompressedPubkey(p);
  return ripemd160(sha256(pub));
}

console.log("\n== engine finds a hidden key (compressed) ==");
{
  const rangeStart = 1000000n;
  const rangeEnd = 1050000n;
  const secret = 1037213n; // inside range, not aligned to any window boundary
  const target = targetFor(secret, true);
  const eng = new CpuEngine({ rangeStart, rangeEnd, target, windowSize: 256, compressed: true });
  let found = null;
  while (!eng.done) { const f = eng.step(); if (f) { found = f; break; } }
  check("found a match", found !== null);
  check("recovered the exact secret key", !!found && found.key === secret,
    found ? `got ${found.key}` : "none");
  check("recovered hash160 matches target", !!found && bytesToHex(found.hash160) === bytesToHex(target));
}

console.log("\n== engine finds key at window boundary (off-by-one guard) ==");
for (const secret of [1000000n, 1000255n, 1000256n, 1000257n, 1049999n]) {
  const eng = new CpuEngine({
    rangeStart: 1000000n, rangeEnd: 1050000n,
    target: targetFor(secret, true), windowSize: 256, compressed: true,
  });
  let found = null;
  while (!eng.done) { const f = eng.step(); if (f) { found = f; break; } }
  check(`finds boundary key ${secret}`, !!found && found.key === secret, found ? `got ${found.key}` : "none");
}

console.log("\n== engine reports no false positive when key absent ==");
{
  // target for a key OUTSIDE the scanned range
  const eng = new CpuEngine({
    rangeStart: 1000000n, rangeEnd: 1002000n,
    target: targetFor(9999999n, true), windowSize: 128, compressed: true,
  });
  let found = null;
  while (!eng.done) { const f = eng.step(); if (f) { found = f; break; } }
  check("no false positive on absent key", found === null);
  check("scanned the whole range", eng.scanned === 2001n, `scanned=${eng.scanned}`);
}

console.log("\n== resume from checkpoint yields same result ==");
{
  const secret = 1030000n;
  const target = targetFor(secret, true);
  // Scan first half, stop, then resume from the recorded position.
  const eng1 = new CpuEngine({ rangeStart: 1000000n, rangeEnd: 1050000n, target, windowSize: 256 });
  let steps = 0;
  while (!eng1.done && steps < 40) { if (eng1.step()) break; steps++; }
  const resumePos = eng1.position;
  const eng2 = new CpuEngine({ rangeStart: 1000000n, rangeEnd: 1050000n, target, windowSize: 256, startFrom: resumePos });
  let found = null;
  while (!eng2.done) { const f = eng2.step(); if (f) { found = f; break; } }
  check("resumed scan finds the key", !!found && found.key === secret, found ? `got ${found.key}` : "none");
}

console.log("\n== uncompressed mode works too ==");
{
  const secret = 1020000n;
  const eng = new CpuEngine({
    rangeStart: 1000000n, rangeEnd: 1050000n,
    target: targetFor(secret, false), windowSize: 256, compressed: false,
  });
  let found = null;
  while (!eng.done) { const f = eng.step(); if (f) { found = f; break; } }
  check("finds key via uncompressed hash160", !!found && found.key === secret, found ? `got ${found.key}` : "none");
}

console.log(`\n==== ${passed} passed, ${failed} failed ====\n`);
process.exit(failed === 0 ? 0 : 1);
