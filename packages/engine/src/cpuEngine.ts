// CPU search engine for a Bitcoin-puzzle hash160 target.
//
// Strategy: walk the range sequentially using batched elliptic-curve additions
// (one modular inversion amortized over a whole window via Montgomery's trick),
// then for each candidate point compute hash160(compressed pubkey) and compare
// against the target. This mirrors what the GPU kernels do per-thread, so CPU
// and GPU verify each other.
//
// No fake numbers: throughput is measured from wall-clock time over real work.

import {
  scalarMulG, precomputeMultiplesOfG, batchAddDeltas, affineAdd,
  compressedPubkey, uncompressedPubkey, type Affine,
} from "../../core/src/secp256k1.ts";
import { sha256 } from "../../core/src/sha256.ts";
import { ripemd160 } from "../../core/src/ripemd160.ts";

export interface EngineOptions {
  rangeStart: bigint;
  rangeEnd: bigint; // inclusive
  target: Uint8Array; // 20-byte hash160
  windowSize?: number; // candidates per batch (default 1024)
  compressed?: boolean; // check compressed pubkey hash160 (default true)
  startFrom?: bigint; // resume point (defaults to rangeStart)
}

export interface Found {
  key: bigint;
  hash160: Uint8Array;
  compressed: boolean;
}

export class CpuEngine {
  readonly rangeStart: bigint;
  readonly rangeEnd: bigint;
  readonly windowSize: number;
  readonly compressed: boolean;
  private target: Uint8Array;
  private t0: number; // target prefix bytes for fast rejection
  private t1: number;
  private t2: number;
  private t3: number;
  private table: Affine[]; // [1G, 2G, ... windowSize*G]
  private cursor: bigint; // next key to scan
  private base: Affine | null = null; // point for key === cursor
  private _scanned = 0n;

  constructor(opts: EngineOptions) {
    this.rangeStart = opts.rangeStart;
    this.rangeEnd = opts.rangeEnd;
    this.windowSize = opts.windowSize ?? 1024;
    this.compressed = opts.compressed ?? true;
    this.target = opts.target;
    this.t0 = opts.target[0]; this.t1 = opts.target[1];
    this.t2 = opts.target[2]; this.t3 = opts.target[3];
    this.cursor = opts.startFrom ?? opts.rangeStart;
    this.table = precomputeMultiplesOfG(this.windowSize);
  }

  get scanned(): bigint { return this._scanned; }
  get position(): bigint { return this.cursor; }
  get done(): boolean { return this.cursor > this.rangeEnd; }

  /** Scan one window. Returns a Found if the target matched, else null. */
  step(): Found | null {
    if (this.done) return null;
    // Establish base point for the current cursor key.
    if (this.base === null) this.base = scalarMulG(this.cursor);

    // How many keys remain (cap the window at range end).
    const remaining = this.rangeEnd - this.cursor + 1n;
    const n = remaining < BigInt(this.windowSize) ? Number(remaining) : this.windowSize;

    // Candidate 0 is the base (key = cursor). Candidates 1..n-1 use deltas.
    const base = this.base;
    let hit = this.check(base, this.cursor);
    if (hit) return hit;

    if (n > 1) {
      const deltas = this.table.slice(0, n - 1); // 1G..(n-1)G
      const pts = batchAddDeltas(base, deltas);
      for (let i = 0; i < pts.length; i++) {
        hit = this.check(pts[i], this.cursor + BigInt(i + 1));
        if (hit) return hit;
      }
      // Advance base by n*G: base + n*G.  table[n-1] === n*G.
      this.base = affineAdd(base, this.table[n - 1]);
    } else {
      this.base = null; // force recompute (only happens at the very last key)
    }

    this.cursor += BigInt(n);
    this._scanned += BigInt(n);
    return null;
  }

  private check(p: Affine, key: bigint): Found | null {
    const pub = this.compressed ? compressedPubkey(p) : uncompressedPubkey(p);
    const sh = sha256(pub);
    const h = ripemd160(sh);
    // fast reject on first 4 bytes before full compare
    if (h[0] === this.t0 && h[1] === this.t1 && h[2] === this.t2 && h[3] === this.t3) {
      let full = true;
      for (let j = 4; j < 20; j++) if (h[j] !== this.target[j]) { full = false; break; }
      if (full) return { key, hash160: h, compressed: this.compressed };
    }
    return null;
  }
}
