// WGSL-equivalent secp256k1 EC (Jacobian), built on the verified field model.
// Mirrors the tested TS core's jDouble/jAdd formulas. Verified in ec.test.mjs
// against scalarMulG from the reference core.
import { fromBig, toBig, addMod, subMod, mulMod, sqrMod, invMod } from "./field.mjs";

const ZERO = () => new Uint32Array(16);
const isZero = (a) => { for (let i = 0; i < 16; i++) if (a[i]) return false; return true; };
export const GX = fromBig(0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n);
export const GY = fromBig(0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n);
const THREE = fromBig(3n), EIGHT = fromBig(8n), TWO = fromBig(2n);

function jdouble(P) {
  if (isZero(P.Z) || isZero(P.Y)) return { X: fromBig(1n), Y: fromBig(1n), Z: ZERO() };
  const A = sqrMod(P.X), B = sqrMod(P.Y), C = sqrMod(B);
  let t = addMod(P.X, B); t = sqrMod(t); t = subMod(t, A); t = subMod(t, C);
  const D = addMod(t, t);
  const E = mulMod(THREE, A);
  const F = sqrMod(E);
  const X3 = subMod(F, addMod(D, D));
  const Y3 = subMod(mulMod(E, subMod(D, X3)), mulMod(EIGHT, C));
  const Z3 = mulMod(addMod(P.Y, P.Y), P.Z); // 2*Y*Z
  return { X: X3, Y: Y3, Z: Z3 };
}
function jadd(P, Q) {
  if (isZero(P.Z)) return { X: Uint32Array.from(Q.X), Y: Uint32Array.from(Q.Y), Z: Uint32Array.from(Q.Z) };
  if (isZero(Q.Z)) return { X: Uint32Array.from(P.X), Y: Uint32Array.from(P.Y), Z: Uint32Array.from(P.Z) };
  const Z1 = sqrMod(P.Z), Z2 = sqrMod(Q.Z);
  const U1 = mulMod(P.X, Z2), U2 = mulMod(Q.X, Z1);
  const S1 = mulMod(mulMod(P.Y, Q.Z), Z2), S2 = mulMod(mulMod(Q.Y, P.Z), Z1);
  const eqU = toBig(U1) === toBig(U2), eqS = toBig(S1) === toBig(S2);
  if (eqU) { if (!eqS) return { X: fromBig(1n), Y: fromBig(1n), Z: ZERO() }; return jdouble(P); }
  const H = subMod(U2, U1);
  const I = sqrMod(addMod(H, H));
  const J = mulMod(H, I);
  const r = addMod(subMod(S2, S1), subMod(S2, S1));
  const V = mulMod(U1, I);
  const X3 = subMod(subMod(sqrMod(r), J), addMod(V, V));
  const Y3 = subMod(mulMod(r, subMod(V, X3)), addMod(mulMod(S1, J), mulMod(S1, J)));
  let Z3 = subMod(subMod(sqrMod(addMod(P.Z, Q.Z)), Z1), Z2);
  Z3 = mulMod(Z3, H);
  return { X: X3, Y: Y3, Z: Z3 };
}

// k as a bigint. Returns affine {x,y} limb arrays.
export function scalarMulG(k) {
  let acc = { X: fromBig(1n), Y: fromBig(1n), Z: ZERO() };
  let add = { X: Uint32Array.from(GX), Y: Uint32Array.from(GY), Z: fromBig(1n) };
  for (let bit = 0; bit < 256; bit++) {
    if ((k >> BigInt(bit)) & 1n) acc = jadd(acc, add);
    add = jdouble(add);
  }
  const zi = invMod(acc.Z);
  const zi2 = sqrMod(zi), zi3 = mulMod(zi2, zi);
  return { x: mulMod(acc.X, zi2), y: mulMod(acc.Y, zi3) };
}

// compressed pubkey (33 bytes): prefix + big-endian x
export function compressed(x, y) {
  const o = new Uint8Array(33);
  o[0] = (y[0] & 1) ? 0x03 : 0x02;
  const xb = toBig(x);
  for (let i = 0; i < 32; i++) o[1 + i] = Number((xb >> BigInt((31 - i) * 8)) & 0xffn);
  return o;
}
