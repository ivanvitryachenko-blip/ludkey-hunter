// Bitcoin Puzzle definitions.
//
// The "Bitcoin puzzle transaction" (2015) deliberately placed funds at
// addresses whose private keys lie in known, published ranges: puzzle #N has a
// private key in [2^(N-1), 2^N - 1]. The creator funded them as a public
// challenge, so searching these specific, published ranges is the intended use.
//
// IMPORTANT (honesty): puzzle #71's public key is NOT exposed on-chain (the
// address has no outgoing transaction), so only hash160 search is possible —
// Pollard's-kangaroo / BSGS (which need the public key) do NOT apply to #71.

import { addressToHash160, bytesToHex } from "./address.ts";

export interface PuzzleDef {
  number: number;
  address: string;
  /** inclusive range start (private key) */
  rangeStart: bigint;
  /** inclusive range end (private key) */
  rangeEnd: bigint;
  /** whether the public key is exposed on-chain (enables kangaroo/BSGS) */
  pubkeyExposed: boolean;
  solved: boolean;
}

/**
 * Puzzle #72 — the primary target of LudKey Hunter.
 * Range: [2^71, 2^72 - 1]. Address corroborated across public puzzle sources;
 * the Base58Check checksum is verified at load time (see getTargetHash160).
 */
export const PUZZLE_72: PuzzleDef = {
  number: 72,
  address: "1JTK7s9YVYywfm5XUH7RNhHJH1LshCaRFR",
  rangeStart: 1n << 71n, // 0x800000000000000000
  rangeEnd: (1n << 72n) - 1n, // 0xffffffffffffffffff
  pubkeyExposed: false,
  solved: false,
};

/**
 * A few solved low puzzles, used as end-to-end correctness vectors
 * (private key -> compressed-pubkey hash160 -> address). These let us prove the
 * whole pipeline finds a known key without touching the network.
 * key = N for puzzle #N in these trivial low cases is NOT generally true; these
 * specific (key,address) pairs are the published solutions.
 */
export const SOLVED_VECTORS: { number: number; key: bigint; address: string }[] = [
  { number: 1, key: 0x1n, address: "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH" },
  { number: 2, key: 0x3n, address: "1CUNEBjYrCn2y1SdiUMohaKUi4wpP326Lb" },
  { number: 3, key: 0x7n, address: "19ZewH8Kk1PDbSNdJ97FP4EiCjTRaZMZQA" },
  { number: 4, key: 0x8n, address: "1EhqbyUMvvs7BfL8goY6qcPbD6YKfPqb7e" },
  { number: 5, key: 0x15n, address: "1E6NuFjCi27W5zoXg8TRdcSRq84zJeBW3k" },
  { number: 6, key: 0x31n, address: "1PitScNLyp2HCygzadCh7FveTnfmpPbfp8" },
  { number: 7, key: 0x4cn, address: "1McVt1vMtCC7yn5b9wgX1833yCcLXzueeC" },
  { number: 10, key: 0x202n, address: "1LeBZP5QCwwgXRtmVUvTVrraqPUokyLHqe" },
];

let _targetHash160: Uint8Array | null = null;

/**
 * Target hash160 for the active puzzle (#72). Decoding the address with our own
 * Base58Check decoder validates its checksum — if the stored address were
 * malformed this would throw at startup rather than silently search a bad hash.
 */
export function getTargetHash160(puzzle: PuzzleDef = PUZZLE_72): Uint8Array {
  if (puzzle === PUZZLE_72 && _targetHash160) return _targetHash160;
  const h = addressToHash160(puzzle.address);
  if (puzzle === PUZZLE_72) _targetHash160 = h;
  return h;
}

export function getTargetHash160Hex(puzzle: PuzzleDef = PUZZLE_72): string {
  return bytesToHex(getTargetHash160(puzzle));
}

export function rangeSize(puzzle: PuzzleDef = PUZZLE_72): bigint {
  return puzzle.rangeEnd - puzzle.rangeStart + 1n;
}
