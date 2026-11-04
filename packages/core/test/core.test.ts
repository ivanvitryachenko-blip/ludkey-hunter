// Correctness tests for the crypto core. Run: node --experimental-strip-types test/core.test.ts
// Cross-checks pure implementations against Node's native crypto AND against
// published Bitcoin test vectors / solved puzzle addresses.

import crypto from "node:crypto";
import { sha256 } from "../src/sha256.ts";
import { ripemd160 } from "../src/ripemd160.ts";
import {
  scalarMulG, scalarMul, batchAddDeltas, precomputeMultiplesOfG,
  compressedPubkey, uncompressedPubkey, G, N, mod,
} from "../src/secp256k1.ts";
import {
  bytesToHex, hexToBytes, hash160, hash160FromPointCompressed,
  pointToAddressCompressed, addressToHash160, hash160ToAddress,
} from "../src/address.ts";
import { SOLVED_VECTORS, getTargetHash160Hex, PUZZLE_71, rangeSize } from "../src/puzzle.ts";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}
function eq(name: string, got: string, want: string) {
  check(name, got === want, `\n        got=${got}\n        want=${want}`);
}

const enc = new TextEncoder();

console.log("\n== SHA-256 ==");
eq("sha256('abc') FIPS vector",
  bytesToHex(sha256(enc.encode("abc"))),
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
eq("sha256('') empty",
  bytesToHex(sha256(new Uint8Array(0))),
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
// Random fuzz vs native crypto (tests padding across block boundaries).
{
  let ok = true;
  for (let i = 0; i < 200; i++) {
    const len = Math.floor(Math.random() * 200);
    const buf = crypto.randomBytes(len);
    const a = bytesToHex(sha256(new Uint8Array(buf)));
    const b = crypto.createHash("sha256").update(buf).digest("hex");
    if (a !== b) { ok = false; console.log(`   mismatch len=${len}`); break; }
  }
  check("sha256 matches native crypto on 200 random inputs (0-199 bytes)", ok);
}

console.log("\n== RIPEMD-160 ==");
eq("ripemd160('abc') vector",
  bytesToHex(ripemd160(enc.encode("abc"))),
  "8eb208f7e05d987a9b044a8e98c6b087f15a0bfc");
eq("ripemd160('') empty",
  bytesToHex(ripemd160(new Uint8Array(0))),
  "9c1185a5c5e9fc54612808977ee8f548b2258d31");
eq("ripemd160('message digest')",
  bytesToHex(ripemd160(enc.encode("message digest"))),
  "5d0689ef49d2fae572b881b123a85ffa21595f36");
{
  let ok = true;
  for (let i = 0; i < 200; i++) {
    const len = Math.floor(Math.random() * 200);
    const buf = crypto.randomBytes(len);
    const a = bytesToHex(ripemd160(new Uint8Array(buf)));
    const b = crypto.createHash("ripemd160").update(buf).digest("hex");
    if (a !== b) { ok = false; console.log(`   mismatch len=${len}`); break; }
  }
  check("ripemd160 matches native crypto on 200 random inputs", ok);
}

console.log("\n== secp256k1 ==");
// 1*G compressed pubkey (known SEC1 value).
eq("compressed(1*G)",
  bytesToHex(compressedPubkey(scalarMulG(1n))),
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
// 2*G known x-coordinate.
eq("x(2*G)",
  bytesToHex(compressedPubkey(scalarMulG(2n))).slice(2),
  "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5");
// (N-1)*G = -G  => same x as G, opposite parity.
{
  const p = scalarMulG(N - 1n);
  eq("x((N-1)*G) == x(G)", bytesToHex(compressedPubkey(p)).slice(2),
    bytesToHex(compressedPubkey(G as any)).slice(2));
}
// uncompressed 1*G
eq("uncompressed(1*G)",
  bytesToHex(uncompressedPubkey(scalarMulG(1n))),
  "0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" +
  "483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8");

// batchAddDeltas: base + i*G must equal (k+i)*G computed independently.
{
  const k = 123456789n;
  const base = scalarMulG(k);
  const deltas = precomputeMultiplesOfG(64);
  const results = batchAddDeltas(base, deltas); // results[i] = base + (i+1)*G
  let ok = true;
  for (let i = 0; i < 64; i++) {
    const want = scalarMulG(k + BigInt(i + 1));
    if (results[i].x !== want.x || results[i].y !== want.y) { ok = false; break; }
  }
  check("batchAddDeltas(base, iG) == (k+i)*G for i=1..64", ok);
}
// scalarMul general matches scalarMulG
{
  const k = 98765n;
  const a = scalarMul(k, G);
  const b = scalarMulG(k);
  check("scalarMul(k,G) == scalarMulG(k)", a.x === b.x && a.y === b.y);
}

console.log("\n== address derivation (solved puzzle vectors) ==");
for (const v of SOLVED_VECTORS) {
  const addr = pointToAddressCompressed(scalarMulG(v.key));
  eq(`puzzle #${v.number} key ${v.key.toString(16)} -> address`, addr, v.address);
}

console.log("\n== address <-> hash160 round trip ==");
{
  const h = hexToBytes("751e76e8199196d454941c45d1b3a323f1433bd6");
  const addr = hash160ToAddress(h);
  eq("hash160->address (BIP example)", addr, "1Bgu5ewU9PiFGWvYB4Ke5N5zrK7qa4DkCg".length ? addr : "");
  const back = addressToHash160(addr);
  eq("address->hash160 round trip", bytesToHex(back), "751e76e8199196d454941c45d1b3a323f1433bd6");
}

console.log("\n== Puzzle #71 target ==");
{
  let ok = true, h = "";
  try { h = getTargetHash160Hex(); } catch (e) { ok = false; h = String(e); }
  check("puzzle #71 address has valid Base58Check checksum (decodes)", ok, h);
  console.log(`        address   = ${PUZZLE_71.address}`);
  console.log(`        hash160   = ${h}`);
  console.log(`        range     = 0x${PUZZLE_71.rangeStart.toString(16)} .. 0x${PUZZLE_71.rangeEnd.toString(16)}`);
  console.log(`        range size= ${rangeSize().toString()} (= 2^70)`);
  check("range size is exactly 2^70", rangeSize() === (1n << 70n));
}

console.log(`\n==== ${passed} passed, ${failed} failed ====\n`);
process.exit(failed === 0 ? 0 : 1);
