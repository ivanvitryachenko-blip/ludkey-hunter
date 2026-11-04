// WGSL-equivalent secp256k1 field arithmetic, written in JS using ONLY the
// integer operations WGSL offers (u32 add/mul/bitops/shift, all wrapping, and
// NO 64-bit type). A field element is 16 limbs of 16 bits (index 0 = least
// significant), so every 16x16 product fits in a u32 — the key trick for WGSL.
//
// This file is the correctness model: field.test.mjs checks it against BigInt.
// The WGSL kernel is a direct transliteration of these exact routines, so once
// this passes, the GPU code is high-confidence (remaining risk is WGSL syntax,
// caught by the on-device self-test).

export const NLIMB = 16;

// p = 2^256 - 2^32 - 977, as sixteen 16-bit limbs (little-endian).
export const P = (() => {
  let p = (1n << 256n) - (1n << 32n) - 977n;
  const o = new Uint32Array(16);
  for (let i = 0; i < 16; i++) { o[i] = Number(p & 0xffffn); p >>= 16n; }
  return o;
})();

export function fromBig(x) {
  const o = new Uint32Array(16);
  x = ((x % (1n << 256n)) + (1n << 256n)) % (1n << 256n);
  for (let i = 0; i < 16; i++) { o[i] = Number(x & 0xffffn); x >>= 16n; }
  return o;
}
export function toBig(a) {
  let x = 0n;
  for (let i = 15; i >= 0; i--) x = (x << 16n) | BigInt(a[i] & 0xffff);
  return x;
}

// compare a vs P: true if a >= P
function g_e_p(a) {
  for (let i = 15; i >= 0; i--) { if (a[i] !== P[i]) return a[i] > P[i]; }
  return true;
}
function subP(a) { // a -= P (assumes a >= P)
  let borrow = 0;
  for (let i = 0; i < 16; i++) { let d = a[i] - P[i] - borrow; if (d < 0) { d += 0x10000; borrow = 1; } else borrow = 0; a[i] = d; }
}

export function addMod(a, b) {
  const r = new Uint32Array(16); let carry = 0;
  for (let i = 0; i < 16; i++) { const s = a[i] + b[i] + carry; r[i] = s & 0xffff; carry = s >>> 16; }
  if (carry || g_e_p(r)) subP(r);
  return r;
}
export function subMod(a, b) {
  const r = new Uint32Array(16); let borrow = 0;
  for (let i = 0; i < 16; i++) { let d = a[i] - b[i] - borrow; if (d < 0) { d += 0x10000; borrow = 1; } else borrow = 0; r[i] = d; }
  if (borrow) { // add P back
    let carry = 0;
    for (let i = 0; i < 16; i++) { const s = r[i] + P[i] + carry; r[i] = s & 0xffff; carry = s >>> 16; }
  }
  return r;
}

// Schoolbook multiply -> 32-limb product, then fold mod p. All ops u32-safe.
export function mulMod(a, b) {
  const t = new Uint32Array(32);
  for (let i = 0; i < 16; i++) {
    let carry = 0;
    for (let j = 0; j < 16; j++) {
      const cur = t[i + j] + a[i] * b[j] + carry; // < 2^32, safe
      t[i + j] = cur & 0xffff; carry = cur >>> 16;
    }
    t[i + 16] = carry; // t[i+16] was 0 before this i
  }
  return reduce(t);
}
export function sqrMod(a) { return mulMod(a, a); }

// Reduce a 32-limb (512-bit) value mod p using 2^256 ≡ 2^32 + 977 (0x1000003d1).
function reduce(t) {
  for (let pass = 0; pass < 3; pass++) {
    const c = t.slice(16, 32);           // high 256 bits
    for (let i = 16; i < 32; i++) t[i] = 0;
    // t[0..] += c * 977   (at offset 0)
    let carry = 0;
    for (let i = 0; i < 16; i++) { const cur = t[i] + c[i] * 977 + carry; t[i] = cur & 0xffff; carry = cur >>> 16; }
    t[16] += carry;
    // t[2..] += c         (at offset 2 limbs = 2^32)
    carry = 0;
    for (let i = 0; i < 16; i++) { const cur = t[i + 2] + c[i] + carry; t[i + 2] = cur & 0xffff; carry = cur >>> 16; }
    t[18] += carry;
  }
  const r = new Uint32Array(16);
  for (let i = 0; i < 16; i++) r[i] = t[i] & 0xffff;
  // t[16..] should be 0 now; a couple of conditional subtractions finish it.
  let guard = 0;
  while (g_e_p(r) && guard++ < 8) subP(r);
  return r;
}

// Modular inverse via Fermat: a^(p-2). p-2 as limbs.
const PM2 = (() => { let x = (1n << 256n) - (1n << 32n) - 979n; return fromBig(x); })();
export function invMod(a) {
  let result = fromBig(1n);
  let base = Uint32Array.from(a);
  for (let bit = 0; bit < 256; bit++) {
    if ((PM2[bit >> 4] >>> (bit & 15)) & 1) result = mulMod(result, base);
    base = sqrMod(base);
  }
  return result;
}
