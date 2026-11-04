// Bitcoin P2PKH address derivation: hash160 = RIPEMD160(SHA256(pubkey)),
// address = Base58Check(0x00 || hash160).

import { sha256 } from "./sha256.ts";
import { ripemd160 } from "./ripemd160.ts";
import { compressedPubkey, uncompressedPubkey, type Affine } from "./secp256k1.ts";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

/** hash160 of the compressed public key for a point. */
export function hash160FromPointCompressed(point: Affine): Uint8Array {
  return hash160(compressedPubkey(point));
}

/** hash160 of the uncompressed public key for a point. */
export function hash160FromPointUncompressed(point: Affine): Uint8Array {
  return hash160(uncompressedPubkey(point));
}

export function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.startsWith("0x")) hex = hex.slice(2);
  if (hex.length % 2 !== 0) hex = "0" + hex;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function base58Encode(data: Uint8Array): string {
  let x = 0n;
  for (const b of data) x = x * 256n + BigInt(b);
  let out = "";
  while (x > 0n) {
    const r = Number(x % 58n);
    x /= 58n;
    out = B58[r] + out;
  }
  for (let i = 0; i < data.length && data[i] === 0; i++) out = "1" + out;
  return out;
}

export function base58Decode(s: string): Uint8Array {
  let x = 0n;
  for (const ch of s) {
    const idx = B58.indexOf(ch);
    if (idx < 0) throw new Error("invalid base58 char: " + ch);
    x = x * 58n + BigInt(idx);
  }
  const bytes: number[] = [];
  while (x > 0n) {
    bytes.unshift(Number(x & 0xffn));
    x >>= 8n;
  }
  for (let i = 0; i < s.length && s[i] === "1"; i++) bytes.unshift(0);
  return new Uint8Array(bytes);
}

/** Base58Check-encode a P2PKH address from a 20-byte hash160. */
export function hash160ToAddress(h160: Uint8Array, version = 0x00): string {
  const payload = new Uint8Array(21);
  payload[0] = version;
  payload.set(h160, 1);
  const checksum = sha256(sha256(payload)).slice(0, 4);
  const full = new Uint8Array(25);
  full.set(payload, 0);
  full.set(checksum, 21);
  return base58Encode(full);
}

/** Extract the 20-byte hash160 from a Base58Check P2PKH address. */
export function addressToHash160(addr: string): Uint8Array {
  const decoded = base58Decode(addr);
  if (decoded.length !== 25) throw new Error("bad address length");
  const payload = decoded.slice(0, 21);
  const checksum = decoded.slice(21);
  const expected = sha256(sha256(payload)).slice(0, 4);
  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== expected[i]) throw new Error("bad address checksum");
  }
  return payload.slice(1);
}

export function pointToAddressCompressed(point: Affine): string {
  return hash160ToAddress(hash160FromPointCompressed(point));
}
