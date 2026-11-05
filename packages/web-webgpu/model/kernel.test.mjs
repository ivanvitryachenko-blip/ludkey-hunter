// Proves the NEW windowed batch-inversion kernel produces exactly the same
// points (and therefore hash160s) as a per-key scalar multiplication, for real
// Puzzle #72-range keys. If this passes, the WGSL transliteration is high-
// confidence (only WGSL syntax remains, caught by the on-device self-test).
import { toBig } from "./field.mjs";
import { scalarMulG } from "./ec.mjs";
import { batchModInv, batchAddDeltas, deltaTable, kernelWindow } from "./kernel.mjs";
import { invMod } from "./field.mjs";
import { fromBig } from "./field.mjs";

let pass = 0, fail = 0;
const ck = (n, c) => { c ? pass++ : fail++; console.log((c ? "  PASS  " : "  FAIL  ") + n); };

// 1. batch inversion equals individual inversion
{
  const vals = [1n, 2n, 3n, 7n, 0x123456789abcdefn, (1n << 200n) + 5n, 0xdeadbeefn, 999n].map(fromBig);
  const got = batchModInv(vals);
  let ok = true;
  for (let i = 0; i < vals.length; i++) if (toBig(got[i]) !== toBig(invMod(vals[i]))) ok = false;
  ck("batch inversion matches per-value invMod (8 values)", ok);
}

// 2. windowed stepping matches per-key scalarMulG across the #72 range
{
  const W = 64;
  const table = deltaTable(W);
  const bases = [
    1n, 2n, 0x15n,
    (1n << 71n),                       // #72 range start
    (1n << 71n) + 1000n,
    (1n << 71n) + 0xabcdefn,
    (1n << 72n) - BigInt(W) - 1n,      // near #72 range end
    0x40000000000000abc0n,
  ];
  let ok = true, firstBad = null;
  for (const b of bases) {
    const win = kernelWindow(b, W, table);
    for (let j = 0; j < W; j++) {
      const ref = scalarMulG(b + BigInt(j));
      if (win[j] === null || toBig(win[j].x) !== toBig(ref.x) || toBig(win[j].y) !== toBig(ref.y)) {
        ok = false; firstBad = { base: b.toString(16), j }; break;
      }
    }
    if (!ok) break;
  }
  ck("windowed batch-inversion == per-key scalarMulG (8 bases x 64 keys, incl #72 ends)" + (firstBad ? " bad=" + JSON.stringify(firstBad) : ""), ok);
}

// 3. larger window still exact (batch size is tunable; correctness must hold)
{
  const W = 256;
  const table = deltaTable(W);
  const b = (1n << 71n) + 0x5555n;
  const win = kernelWindow(b, W, table);
  let ok = true;
  for (let j = 0; j < W; j++) { const ref = scalarMulG(b + BigInt(j)); if (toBig(win[j].x) !== toBig(ref.x)) { ok = false; break; } }
  ck("windowed stepping exact at W=256", ok);
}

// 4. consecutive windows tile the range with no gap/overlap (key continuity)
{
  const W = 32;
  const table = deltaTable(W);
  const start = (1n << 71n) + 0x99n;
  const w0 = kernelWindow(start, W, table);
  const w1 = kernelWindow(start + BigInt(W), W, table);
  const refLast = scalarMulG(start + BigInt(W) - 1n);
  const refNext = scalarMulG(start + BigInt(W));
  const ok = toBig(w0[W - 1].x) === toBig(refLast.x) && toBig(w1[0].x) === toBig(refNext.x);
  ck("adjacent windows are contiguous (no gap, no overlap)", ok);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
