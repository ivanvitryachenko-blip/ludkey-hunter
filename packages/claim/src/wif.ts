// WIF (Wallet Import Format) encoding and destination-address decoding.
// Lets a found private key be imported into any wallet, and lets a sweep
// transaction pay out to a legacy (1...) or native-segwit (bc1q...) address.

import { sha256 } from "../../core/src/sha256.ts";
import { base58Encode, base58Decode } from "../../core/src/address.ts";

/** Compressed-key WIF for mainnet (version 0x80, 0x01 compression flag). */
export function toWIF(privkey: bigint, compressed = true): string {
  const key = new Uint8Array(32);
  let x = privkey;
  for (let i = 31; i >= 0; i--) { key[i] = Number(x & 0xffn); x >>= 8n; }
  const payload = new Uint8Array(compressed ? 34 : 33);
  payload[0] = 0x80;
  payload.set(key, 1);
  if (compressed) payload[33] = 0x01;
  const checksum = sha256(sha256(payload)).slice(0, 4);
  const full = new Uint8Array(payload.length + 4);
  full.set(payload, 0); full.set(checksum, payload.length);
  return base58Encode(full);
}

export interface Destination { type: "p2pkh" | "p2wpkh"; program: Uint8Array; }

/** Decode a mainnet destination address into its output type + 20-byte program. */
export function decodeAddress(addr: string): Destination {
  if (addr.startsWith("1")) {
    const d = base58Decode(addr);
    if (d.length !== 25 || d[0] !== 0x00) throw new Error("not a mainnet P2PKH address");
    const payload = d.slice(0, 21);
    const sum = sha256(sha256(payload)).slice(0, 4);
    for (let i = 0; i < 4; i++) if (sum[i] !== d[21 + i]) throw new Error("bad address checksum");
    return { type: "p2pkh", program: d.slice(1, 21) };
  }
  if (addr.startsWith("bc1")) {
    const { version, program } = bech32DecodeSegwit(addr);
    if (version !== 0 || program.length !== 20) throw new Error("only v0 P2WPKH (20-byte) bc1q addresses supported");
    return { type: "p2wpkh", program };
  }
  throw new Error("unsupported address type (use a 1... or bc1q... mainnet address)");
}

/** scriptPubKey bytes for a destination. */
export function scriptPubKey(dest: Destination): Uint8Array {
  if (dest.type === "p2pkh") {
    // OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG
    return Uint8Array.from([0x76, 0xa9, 0x14, ...dest.program, 0x88, 0xac]);
  }
  // P2WPKH: OP_0 <20>
  return Uint8Array.from([0x00, 0x14, ...dest.program]);
}

// --- minimal bech32 (BIP-173) decoder for mainnet segwit v0 ---
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}
function bech32DecodeSegwit(addr: string): { version: number; program: Uint8Array } {
  const lower = addr.toLowerCase();
  const pos = lower.lastIndexOf("1");
  const hrp = lower.slice(0, pos);
  if (hrp !== "bc") throw new Error("not a mainnet (bc) bech32 address");
  const data: number[] = [];
  for (const ch of lower.slice(pos + 1)) { const d = CHARSET.indexOf(ch); if (d < 0) throw new Error("bad bech32 char"); data.push(d); }
  // checksum: bech32 (v0) const = 1
  const poly = bech32Polymod([...hrpExpand(hrp), ...data]);
  if (poly !== 1) throw new Error("bad bech32 checksum (this decoder supports v0 only)");
  const version = data[0];
  const prog5 = data.slice(1, -6);
  // convert 5-bit groups to 8-bit
  let acc = 0, bits = 0; const out: number[] = [];
  for (const v of prog5) { acc = (acc << 5) | v; bits += 5; while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); } }
  return { version, program: Uint8Array.from(out) };
}
