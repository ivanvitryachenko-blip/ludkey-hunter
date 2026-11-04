// Range allocator — the coordination core that makes multi-device search safe.
//
// The published puzzle range is divided into fixed-size chunks. Each chunk is
// handed to exactly one device at a time; a device reports completion, or its
// lease expires and the chunk is reclaimed. This guarantees the two properties
// the spec requires: full coverage with NO overlap, and no two devices ever
// doing the same work.
//
// CRITICAL SCALE NOTE: puzzle #71 with a 2^40 chunk size has 2^30 (~1.07
// billion) chunks. Materializing them all would exhaust memory, so the
// allocator is LAZY — it stores only the frontier (next never-handed-out index)
// plus the small sets of in-flight, reclaimed, and completed chunks. Chunk
// index is a bigint because the count can exceed 2^53 for small chunk sizes.

export type ChunkStatus = "pending" | "assigned" | "done";

export interface Chunk {
  index: bigint;
  start: bigint; // inclusive
  end: bigint;   // inclusive
}

interface Lease {
  deviceId: string;
  leaseUntil: number; // ms epoch
  scanned: bigint;
}

export class RangeAllocator {
  readonly rangeStart: bigint;
  readonly rangeEnd: bigint;
  readonly chunkSize: bigint;
  readonly chunkCount: bigint;
  private leaseMs: number;

  private nextIndex = 0n;                      // lowest index never leased
  private reclaimed: bigint[] = [];            // freed indices (below nextIndex), kept sorted asc
  private active = new Map<string, Lease>();   // key: index.toString()
  private done = new Set<string>();            // completed index strings
  private doneScanned = 0n;                     // keys in completed chunks

  constructor(rangeStart: bigint, rangeEnd: bigint, chunkSize: bigint, leaseMs = 10 * 60 * 1000) {
    if (rangeEnd < rangeStart) throw new Error("rangeEnd < rangeStart");
    if (chunkSize <= 0n) throw new Error("chunkSize must be positive");
    this.rangeStart = rangeStart;
    this.rangeEnd = rangeEnd;
    this.chunkSize = chunkSize;
    this.leaseMs = leaseMs;
    const total = rangeEnd - rangeStart + 1n;
    this.chunkCount = (total + chunkSize - 1n) / chunkSize; // ceil
  }

  /** Analytic chunk bounds for an index — no materialization. */
  chunkAt(index: bigint): Chunk {
    if (index < 0n || index >= this.chunkCount) throw new Error("chunk index out of range");
    const s = this.rangeStart + index * this.chunkSize;
    let e = s + this.chunkSize - 1n;
    if (e > this.rangeEnd) e = this.rangeEnd;
    return { index, start: s, end: e };
  }

  /** Lease the next available chunk to a device. Returns null if none left. */
  lease(deviceId: string, now = Date.now()): Chunk | null {
    this.reclaimExpired(now);
    let index: bigint;
    if (this.reclaimed.length > 0) {
      index = this.reclaimed.shift()!; // smallest freed index first
    } else if (this.nextIndex < this.chunkCount) {
      index = this.nextIndex;
      this.nextIndex += 1n;
    } else {
      return null; // every chunk is assigned or done
    }
    this.active.set(index.toString(), { deviceId, leaseUntil: now + this.leaseMs, scanned: 0n });
    return this.chunkAt(index);
  }

  renew(index: bigint, deviceId: string, scanned?: bigint, now = Date.now()): boolean {
    const l = this.active.get(index.toString());
    if (!l || l.deviceId !== deviceId) return false;
    l.leaseUntil = now + this.leaseMs;
    if (scanned !== undefined) l.scanned = scanned;
    return true;
  }

  complete(index: bigint, deviceId: string): boolean {
    const key = index.toString();
    const l = this.active.get(key);
    if (!l || l.deviceId !== deviceId) return false;
    this.active.delete(key);
    if (!this.done.has(key)) {
      this.done.add(key);
      const c = this.chunkAt(index);
      this.doneScanned += c.end - c.start + 1n;
    }
    return true;
  }

  release(index: bigint, deviceId: string): boolean {
    const key = index.toString();
    const l = this.active.get(key);
    if (!l || l.deviceId !== deviceId) return false;
    this.active.delete(key);
    this.freeIndex(index);
    return true;
  }

  reclaimExpired(now = Date.now()): number {
    let n = 0;
    for (const [key, l] of this.active) {
      if (l.leaseUntil <= now) { this.active.delete(key); this.freeIndex(BigInt(key)); n++; }
    }
    return n;
  }

  private freeIndex(index: bigint): void {
    if (this.done.has(index.toString())) return; // never re-hand a completed chunk
    // insert keeping ascending order (reclaimed stays small in practice)
    let lo = 0, hi = this.reclaimed.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.reclaimed[mid] < index) lo = mid + 1; else hi = mid; }
    if (this.reclaimed[lo] !== index) this.reclaimed.splice(lo, 0, index);
  }

  /** Active leases as chunks (for dashboards). */
  activeChunks(): { chunk: Chunk; deviceId: string; scanned: bigint; leaseUntil: number }[] {
    const out: { chunk: Chunk; deviceId: string; scanned: bigint; leaseUntil: number }[] = [];
    for (const [key, l] of this.active) {
      out.push({ chunk: this.chunkAt(BigInt(key)), deviceId: l.deviceId, scanned: l.scanned, leaseUntil: l.leaseUntil });
    }
    return out;
  }

  summary(now = Date.now()) {
    this.reclaimExpired(now);
    let activeScanned = 0n;
    for (const l of this.active.values()) activeScanned += l.scanned;
    const total = this.rangeEnd - this.rangeStart + 1n;
    const scanned = this.doneScanned + activeScanned;
    return {
      chunkCount: this.chunkCount.toString(),
      pending: (this.chunkCount - this.nextIndex + BigInt(this.reclaimed.length)).toString(),
      assigned: this.active.size,
      done: this.done.size,
      scanned, total,
      percent: total > 0n ? Number((scanned * 1000000n) / total) / 10000 : 0,
    };
  }

  /**
   * Coverage is guaranteed by construction (chunk i spans
   * [start + i*size, start + (i+1)*size - 1], clamped). This verifies the
   * arithmetic on the boundary chunks analytically — no materialization.
   */
  verifyCoverage(): { ok: boolean; reason?: string } {
    const first = this.chunkAt(0n);
    if (first.start !== this.rangeStart) return { ok: false, reason: "first chunk start mismatch" };
    const last = this.chunkAt(this.chunkCount - 1n);
    if (last.end !== this.rangeEnd) return { ok: false, reason: "last chunk end mismatch" };
    // adjacency for an interior sample
    if (this.chunkCount > 1n) {
      const a = this.chunkAt(0n), b = this.chunkAt(1n);
      if (b.start !== a.end + 1n) return { ok: false, reason: "chunk 0/1 not adjacent" };
    }
    return { ok: true };
  }

  serialize(): string {
    return JSON.stringify({
      rangeStart: this.rangeStart.toString(), rangeEnd: this.rangeEnd.toString(),
      chunkSize: this.chunkSize.toString(), nextIndex: this.nextIndex.toString(),
      reclaimed: this.reclaimed.map((x) => x.toString()),
      active: [...this.active.entries()].map(([k, v]) => [k, v.deviceId, v.leaseUntil, v.scanned.toString()]),
      done: [...this.done], doneScanned: this.doneScanned.toString(),
    });
  }

  static deserialize(json: string, leaseMs?: number): RangeAllocator {
    const o = JSON.parse(json);
    const a = new RangeAllocator(BigInt(o.rangeStart), BigInt(o.rangeEnd), BigInt(o.chunkSize), leaseMs);
    a.nextIndex = BigInt(o.nextIndex);
    a.reclaimed = o.reclaimed.map((x: string) => BigInt(x));
    for (const [k, dev, until, scanned] of o.active) a.active.set(k, { deviceId: dev, leaseUntil: until, scanned: BigInt(scanned) });
    a.done = new Set(o.done);
    a.doneScanned = BigInt(o.doneScanned);
    return a;
  }
}
