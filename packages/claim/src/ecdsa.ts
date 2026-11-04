// Deterministic ECDSA (RFC 6979) over secp256k1, low-S, DER-encoded.
//
// Uses the tested secp256k1 core for the group math. HMAC-SHA256 comes from
// Node's crypto (the claim tooling runs under Node). Signatures are verified
// independently by Node's own ECDSA in the tests, so a bug here surfaces as a
// failed verification rather than a silently invalid transaction.

import { createHmac } from "node:crypto";
import { N, scalarMulG, modInv, mod } from "../../core/src/secp256k1.ts";

function bytesToBig(b: Uint8Array): bigint { let x = 0n; for (const v of b) x = (x << 8n) | BigInt(v); return x; }
function bigTo32(x: bigint): Uint8Array { const o = new Uint8Array(32); for (let i = 31; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; }

function hmac(key: Uint8Array, ...msgs: Uint8Array[]): Uint8Array {
  const h = createHmac("sha256", Buffer.from(key));
  for (const m of msgs) h.update(Buffer.from(m));
  return new Uint8Array(h.digest());
}

export interface Signature { r: bigint; s: bigint; }

/**
 * Sign a 32-byte message digest `z` with private key `d`, deterministically.
 * Returns a low-S signature (BIP-62). `z` is the digest bytes (e.g. the
 * transaction sighash: double-SHA256 of the preimage).
 */
export function signDigest(z32: Uint8Array, d: bigint): Signature {
  const z = bytesToBig(z32) % N;
  const x = bigTo32(d);
  const h1 = z32;
  let V = new Uint8Array(32).fill(1);
  let K = new Uint8Array(32).fill(0);
  K = hmac(K, V, Uint8Array.of(0x00), x, h1);
  V = hmac(K, V);
  K = hmac(K, V, Uint8Array.of(0x01), x, h1);
  V = hmac(K, V);
  for (let i = 0; i < 1000; i++) {
    V = hmac(K, V);
    const k = bytesToBig(V) % N;
    if (k >= 1n && k < N) {
      const R = scalarMulG(k);
      const r = mod(R.x, N);
      if (r !== 0n) {
        const kInv = modInv(k, N);
        let s = mod(kInv * mod(z + r * d, N), N);
        if (s !== 0n) {
          if (s > N / 2n) s = N - s; // low-S
          return { r, s };
        }
      }
    }
    K = hmac(K, V, Uint8Array.of(0x00));
    V = hmac(K, V);
  }
  throw new Error("failed to produce signature (exhausted RFC6979 attempts)");
}

/** DER-encode a signature. */
export function toDER(sig: Signature): Uint8Array {
  const enc = (x: bigint): number[] => {
    let b = Array.from(bigTo32(x));
    while (b.length > 1 && b[0] === 0) b.shift();   // strip leading zeros
    if (b[0] & 0x80) b.unshift(0);                   // keep positive
    return b;
  };
  const r = enc(sig.r), s = enc(sig.s);
  const body = [0x02, r.length, ...r, 0x02, s.length, ...s];
  return Uint8Array.from([0x30, body.length, ...body]);
}

/** DER signature + 1-byte SIGHASH type, as used in a scriptSig. */
export function toDERWithHashType(sig: Signature, hashType = 0x01): Uint8Array {
  const der = toDER(sig);
  const out = new Uint8Array(der.length + 1);
  out.set(der, 0); out[der.length] = hashType;
  return out;
}
