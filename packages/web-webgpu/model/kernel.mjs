// WGSL-equivalent model of the NEW search kernel: instead of a full scalar
// multiplication + a field inversion PER key (the old kernel), each GPU thread
// computes its base point once and derives a whole window of consecutive keys
// by affine point addition with a SINGLE Montgomery batch inversion per window.
// This mirrors the tested CPU core (secp256k1.ts batchAddDeltas) but written in
// the exact 16x16-bit field ops the WGSL kernel will use, so kernel.test.mjs
// proves the math before it is transliterated to WGSL.
import { fromBig, toBig, addMod, subMod, mulMod, sqrMod, invMod } from "./field.mjs";
import { scalarMulG } from "./ec.mjs";

// Montgomery batch inversion: given [a0,a1,...], return [a0^-1, a1^-1, ...] with
// ONE real inversion for the whole array (the whole point of the optimisation).
export function batchModInv(vals) {
  const n = vals.length;
  if (n === 0) return [];
  const pref = new Array(n);          // pref[i] = a0*a1*...*ai
  pref[0] = Uint32Array.from(vals[0]);
  for (let i = 1; i < n; i++) pref[i] = mulMod(pref[i - 1], vals[i]);
  let inv = invMod(pref[n - 1]);       // (a0*...*a_{n-1})^-1
  const out = new Array(n);
  for (let i = n - 1; i > 0; i--) {
    out[i] = mulMod(inv, pref[i - 1]); // ai^-1 = inv * (a0*...*a_{i-1})
    inv = mulMod(inv, vals[i]);        // peel ai off
  }
  out[0] = inv;
  return out;
}

// base + delta for each delta, all sharing the same base, so every denominator
// (delta.x - base.x) is independent and the whole set is inverted in one batch.
// Returns affine {x,y} limb arrays, in order. Exceptional denominators (zero,
// i.e. base.x == delta.x) are reported as null so the caller never emits a
// bogus point; within a small consecutive window over a 2^71 range they do not
// occur, but the kernel must not false-match on them.
export function batchAddDeltas(base, deltas) {
  const m = deltas.length;
  const dxs = new Array(m);
  for (let i = 0; i < m; i++) dxs[i] = subMod(deltas[i].x, base.x);
  // Guard: if any dx is zero, substitute 1 for the inversion (its result is
  // discarded) so the batch inverse stays well-defined.
  const zero = [];
  for (let i = 0; i < m; i++) { if (toBig(dxs[i]) === 0n) { zero.push(i); dxs[i] = fromBig(1n); } }
  const inv = batchModInv(dxs);
  const out = new Array(m);
  for (let i = 0; i < m; i++) {
    if (zero.includes(i)) { out[i] = null; continue; }
    const lam = mulMod(subMod(deltas[i].y, base.y), inv[i]); // (y2-y1)/(x2-x1)
    const x3 = subMod(subMod(sqrMod(lam), base.x), deltas[i].x);
    const y3 = subMod(mulMod(lam, subMod(base.x, x3)), base.y);
    out[i] = { x: x3, y: y3 };
  }
  return out;
}

// Precompute the delta table {1G, 2G, ..., (W-1)G} as affine points — in the
// real kernel this is uploaded once and reused for every window/dispatch.
export function deltaTable(W) {
  const t = new Array(W - 1);
  for (let i = 1; i < W; i++) t[i - 1] = scalarMulG(BigInt(i));
  return t;
}

// A window of W consecutive keys starting at baseKey: base point computed once,
// the remaining W-1 derived via one batch inversion. Returns W affine points in
// key order (index j === key baseKey + j).
export function kernelWindow(baseKey, W, table) {
  const base = scalarMulG(baseKey);         // one scalar mul per window
  const pts = batchAddDeltas(base, table.slice(0, W - 1));
  // Safety: a null entry means base.x == delta.x (a doubling, which cannot
  // occur for in-range #72 bases but must never cause a skipped key). Fall back
  // to a direct scalar mul for that single lane so the window is always complete
  // and exact — no gap, no overlap.
  const out = [base];
  for (let i = 0; i < pts.length; i++) out.push(pts[i] === null ? scalarMulG(baseKey + BigInt(i + 1)) : pts[i]);
  return out;
}
