// Build and sign a legacy P2PKH "sweep" transaction that moves every UTXO of
// the puzzle address to a single destination output. The puzzle address is
// legacy (1...), so inputs use the pre-segwit SIGHASH_ALL algorithm.

import { sha256 } from "../../core/src/sha256.ts";
import { scalarMulG, compressedPubkey } from "../../core/src/secp256k1.ts";
import { bytesToHex, hexToBytes } from "../../core/src/address.ts";
import { signDigest, toDERWithHashType } from "./ecdsa.ts";
import { decodeAddress, scriptPubKey, type Destination } from "./wif.ts";

export interface Utxo { txid: string; vout: number; value: number; } // value in sats

function dsha256(b: Uint8Array): Uint8Array { return sha256(sha256(b)); }
function u32le(n: number): Uint8Array { const o = new Uint8Array(4); new DataView(o.buffer).setUint32(0, n >>> 0, true); return o; }
function u64le(n: bigint): Uint8Array { const o = new Uint8Array(8); new DataView(o.buffer).setBigUint64(0, n, true); return o; }
function varint(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) { const o = new Uint8Array(3); o[0] = 0xfd; new DataView(o.buffer).setUint16(1, n, true); return o; }
  const o = new Uint8Array(5); o[0] = 0xfe; new DataView(o.buffer).setUint32(1, n, true); return o;
}
function concat(arrs: Uint8Array[]): Uint8Array {
  let len = 0; for (const a of arrs) len += a.length;
  const o = new Uint8Array(len); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; }
  return o;
}
function pushData(d: Uint8Array): Uint8Array { return concat([varint(d.length), d]); }
function txidToPrevHash(txid: string): Uint8Array { return hexToBytes(txid).reverse(); } // display->internal (LE)

interface BuiltInput { txid: string; vout: number; value: number; scriptSig: Uint8Array; }

function serialize(inputs: BuiltInput[], outScript: Uint8Array, outValue: bigint, version = 1, locktime = 0): Uint8Array {
  const parts: Uint8Array[] = [u32le(version), varint(inputs.length)];
  for (const i of inputs) {
    parts.push(txidToPrevHash(i.txid), u32le(i.vout), pushData(i.scriptSig), u32le(0xffffffff));
  }
  parts.push(varint(1), u64le(outValue), pushData(outScript), u32le(locktime));
  return concat(parts);
}

/** Legacy SIGHASH_ALL preimage digest for input `idx`. */
function legacySighash(inputs: Utxo[], idx: number, sourceScript: Uint8Array, outScript: Uint8Array, outValue: bigint): Uint8Array {
  const built: BuiltInput[] = inputs.map((u, i) => ({ txid: u.txid, vout: u.vout, value: u.value, scriptSig: i === idx ? sourceScript : new Uint8Array(0) }));
  const ser = serialize(built, outScript, outValue);
  return dsha256(concat([ser, u32le(0x01)])); // append SIGHASH_ALL (4 bytes LE)
}

export interface SweepResult { rawHex: string; txid: string; inputs: number; totalIn: number; fee: number; outValue: number; destination: string; feerate: number; }

/**
 * Build + sign a sweep of all `utxos` (which must belong to the puzzle P2PKH
 * address derived from `privkey`) to `destAddr`. Fee = feerate * estimated vsize.
 */
export function buildSweep(privkey: bigint, utxos: Utxo[], destAddr: string, feerateSatPerVb: number): SweepResult {
  if (utxos.length === 0) throw new Error("no UTXOs to sweep");
  const point = scalarMulG(privkey);
  const pub = compressedPubkey(point); // 33 bytes
  // source scriptPubKey = P2PKH of our own compressed pubkey
  const ripemd = ripemd160(sha256(pub));
  const sourceScript = Uint8Array.from([0x76, 0xa9, 0x14, ...ripemd, 0x88, 0xac]);

  const dest: Destination = decodeAddress(destAddr);
  const outScript = scriptPubKey(dest);
  const totalIn = utxos.reduce((a, u) => a + u.value, 0);

  // Estimate vsize: 10 overhead + 148/input (compressed P2PKH) + output size.
  const outSize = dest.type === "p2pkh" ? 34 : 31;
  const vsize = 10 + utxos.length * 148 + outSize;
  const fee = Math.ceil(feerateSatPerVb * vsize);
  const outValue = totalIn - fee;
  if (outValue <= 0) throw new Error(`fee (${fee}) exceeds funds (${totalIn})`);
  const outVal = BigInt(outValue);

  // Sign each input (all from the same key/script here).
  const built: BuiltInput[] = utxos.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, scriptSig: new Uint8Array(0) }));
  for (let i = 0; i < utxos.length; i++) {
    const z = legacySighash(utxos, i, sourceScript, outScript, outVal);
    const sig = signDigest(z, privkey);
    const sigBytes = toDERWithHashType(sig, 0x01);
    built[i].scriptSig = concat([pushData(sigBytes), pushData(pub)]); // <sig> <pubkey>
  }
  const raw = serialize(built, outScript, outVal);
  const txid = bytesToHex(dsha256(raw).reverse());
  return { rawHex: bytesToHex(raw), txid, inputs: utxos.length, totalIn, fee, outValue, destination: destAddr, feerate: feerateSatPerVb };
}

// local ripemd160 import (avoid circular): re-export from core
import { ripemd160 } from "../../core/src/ripemd160.ts";
