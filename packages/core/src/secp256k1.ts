// secp256k1 elliptic curve — field + group arithmetic over BigInt.
// Correctness-first reference. The CPU engine uses the batch-addition helpers
// (Montgomery's trick) here to amortize modular inversions, which is the same
// optimization production key-search tools (BitCrack/keyhunt) rely on.

export const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
export const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
export const Gx = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
export const Gy = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

export interface Affine {
  x: bigint;
  y: bigint;
}

export const G: Affine = { x: Gx, y: Gy };

// Modular reduction that handles negative inputs.
export function mod(a: bigint, m: bigint = P): bigint {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

// Modular inverse via Fermat's little theorem (p is prime). Constant-ish time,
// and self-contained (no extended-Euclid branching to get wrong).
export function modInv(a: bigint, m: bigint = P): bigint {
  return modPow(mod(a, m), m - 2n, m);
}

export function modPow(base: bigint, exp: bigint, m: bigint): bigint {
  base = mod(base, m);
  let result = 1n;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % m;
    base = (base * base) % m;
    exp >>= 1n;
  }
  return result;
}

// --- Jacobian coordinates for scalar multiplication (no per-op inversion) ---
interface Jacobian {
  x: bigint;
  y: bigint;
  z: bigint; // z === 0n represents the point at infinity
}

const JINF: Jacobian = { x: 1n, y: 1n, z: 0n };

function jDouble(p: Jacobian): Jacobian {
  if (p.z === 0n || p.y === 0n) return JINF;
  const { x, y, z } = p;
  const A = (x * x) % P;
  const B = (y * y) % P;
  const C = (B * B) % P;
  let D = (2n * (((x + B) * (x + B)) % P - A - C)) % P;
  D = mod(D);
  const E = (3n * A) % P;
  const F = (E * E) % P;
  const X3 = mod(F - 2n * D);
  const Y3 = mod(E * (D - X3) - 8n * C);
  const Z3 = mod(2n * y * z);
  return { x: X3, y: Y3, z: Z3 };
}

function jAdd(p: Jacobian, q: Jacobian): Jacobian {
  if (p.z === 0n) return q;
  if (q.z === 0n) return p;
  const Z1Z1 = (p.z * p.z) % P;
  const Z2Z2 = (q.z * q.z) % P;
  const U1 = (p.x * Z2Z2) % P;
  const U2 = (q.x * Z1Z1) % P;
  const S1 = (((p.y * q.z) % P) * Z2Z2) % P;
  const S2 = (((q.y * p.z) % P) * Z1Z1) % P;
  if (U1 === U2) {
    if (S1 !== S2) return JINF;
    return jDouble(p);
  }
  const H = mod(U2 - U1);
  const I = (2n * H) % P;
  const I2 = (I * I) % P;
  const J = (H * I2) % P;
  const r = mod(2n * (S2 - S1));
  const V = (U1 * I2) % P;
  const X3 = mod(r * r - J - 2n * V);
  const Y3 = mod(r * (V - X3) - 2n * S1 * J);
  const Z3 = mod((((p.z + q.z) * (p.z + q.z)) % P - Z1Z1 - Z2Z2) * H);
  return { x: X3, y: Y3, z: Z3 };
}

function toAffine(p: Jacobian): Affine {
  if (p.z === 0n) throw new Error("point at infinity has no affine form");
  const zInv = modInv(p.z);
  const zInv2 = (zInv * zInv) % P;
  const zInv3 = (zInv2 * zInv) % P;
  return { x: (p.x * zInv2) % P, y: (p.y * zInv3) % P };
}

const JG: Jacobian = { x: Gx, y: Gy, z: 1n };

/** Scalar multiplication k*G, returning an affine point. k must be in [1, N-1]. */
export function scalarMulG(k: bigint): Affine {
  k = mod(k, N);
  if (k === 0n) throw new Error("scalar 0 maps to infinity");
  let acc = JINF;
  let addend = JG;
  while (k > 0n) {
    if (k & 1n) acc = jAdd(acc, addend);
    addend = jDouble(addend);
    k >>= 1n;
  }
  return toAffine(acc);
}

/** General scalar multiplication k*point (affine in, affine out). */
export function scalarMul(k: bigint, point: Affine): Affine {
  k = mod(k, N);
  if (k === 0n) throw new Error("scalar 0 maps to infinity");
  let acc = JINF;
  let addend: Jacobian = { x: point.x, y: point.y, z: 1n };
  while (k > 0n) {
    if (k & 1n) acc = jAdd(acc, addend);
    addend = jDouble(addend);
    k >>= 1n;
  }
  return toAffine(acc);
}

/** Affine point addition P + Q (distinct, non-inverse points). */
export function affineAdd(a: Affine, b: Affine): Affine {
  const dx = mod(b.x - a.x);
  if (dx === 0n) {
    if (mod(a.y + b.y) === 0n) throw new Error("addition of inverse points");
    return affineDouble(a);
  }
  const s = mod((b.y - a.y) * modInv(dx));
  const x = mod(s * s - a.x - b.x);
  const y = mod(s * (a.x - x) - a.y);
  return { x, y };
}

export function affineDouble(a: Affine): Affine {
  const s = mod(3n * a.x * a.x * modInv(2n * a.y));
  const x = mod(s * s - 2n * a.x);
  const y = mod(s * (a.x - x) - a.y);
  return { x, y };
}

/**
 * Batch modular inversion (Montgomery's trick): invert m field elements using
 * a single modInv plus O(m) multiplications instead of m inversions.
 */
export function batchModInv(values: bigint[]): bigint[] {
  const n = values.length;
  const out = new Array<bigint>(n);
  const prefix = new Array<bigint>(n);
  let acc = 1n;
  for (let i = 0; i < n; i++) {
    prefix[i] = acc;
    acc = (acc * values[i]) % P;
  }
  let inv = modInv(acc);
  for (let i = n - 1; i >= 0; i--) {
    out[i] = (prefix[i] * inv) % P;
    inv = (inv * values[i]) % P;
  }
  return out;
}

/**
 * Compute base + D_i for every delta point D_i, using one batch inversion.
 * All D_i must have x-coordinates distinct from base.x (true for distinct
 * multiples of G in a scan window). Returns affine results in order.
 */
export function batchAddDeltas(base: Affine, deltas: Affine[]): Affine[] {
  const m = deltas.length;
  const dxs = new Array<bigint>(m);
  for (let i = 0; i < m; i++) {
    const dx = mod(deltas[i].x - base.x);
    if (dx === 0n) {
      // Extremely improbable in a real scan; fall back to per-point add.
      dxs[i] = 1n; // placeholder; corrected below
    } else {
      dxs[i] = dx;
    }
  }
  const invs = batchModInv(dxs);
  const out = new Array<Affine>(m);
  for (let i = 0; i < m; i++) {
    const d = deltas[i];
    if (mod(d.x - base.x) === 0n) {
      out[i] = affineAdd(base, d);
      continue;
    }
    const s = mod((d.y - base.y) * invs[i]);
    const x = mod(s * s - base.x - d.x);
    const y = mod(s * (base.x - x) - base.y);
    out[i] = { x, y };
  }
  return out;
}

/** Precompute [1*G, 2*G, ..., count*G] as affine points. */
export function precomputeMultiplesOfG(count: number): Affine[] {
  const out: Affine[] = new Array(count);
  out[0] = { x: Gx, y: Gy };
  for (let i = 1; i < count; i++) {
    out[i] = affineAdd(out[i - 1], G);
  }
  return out;
}

// --- serialization helpers ---

export function toBytes32(x: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/** Compressed SEC1 public key (33 bytes): 0x02/0x03 prefix + 32-byte x. */
export function compressedPubkey(point: Affine): Uint8Array {
  const out = new Uint8Array(33);
  out[0] = (point.y & 1n) === 0n ? 0x02 : 0x03;
  out.set(toBytes32(point.x), 1);
  return out;
}

/** Uncompressed SEC1 public key (65 bytes): 0x04 + x + y. */
export function uncompressedPubkey(point: Affine): Uint8Array {
  const out = new Uint8Array(65);
  out[0] = 0x04;
  out.set(toBytes32(point.x), 1);
  out.set(toBytes32(point.y), 33);
  return out;
}
