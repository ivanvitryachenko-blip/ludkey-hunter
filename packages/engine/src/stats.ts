// Speed/statistics tracker. All numbers derive from real counters and
// wall-clock timestamps — nothing is synthesized.

interface Sample { t: number; scanned: number; }

export class SpeedTracker {
  private start = Date.now();
  private samples: Sample[] = [];
  private totalScanned = 0;
  private maxSpeed = 0;
  private lastScanned = 0;
  private lastT = Date.now();

  /** Record cumulative progress. Call periodically (e.g. each window/second). */
  update(cumulativeScanned: number): void {
    const now = Date.now();
    this.totalScanned = cumulativeScanned;
    const dt = (now - this.lastT) / 1000;
    if (dt >= 0.2) {
      const inst = (cumulativeScanned - this.lastScanned) / dt;
      if (inst > this.maxSpeed) this.maxSpeed = inst;
      this.lastScanned = cumulativeScanned;
      this.lastT = now;
    }
    this.samples.push({ t: now, scanned: cumulativeScanned });
    // keep only last 6 minutes of samples
    const cutoff = now - 6 * 60 * 1000;
    while (this.samples.length > 2 && this.samples[0].t < cutoff) this.samples.shift();
  }

  private windowSpeed(seconds: number): number {
    const now = Date.now();
    const cutoff = now - seconds * 1000;
    let oldest: Sample | null = null;
    for (const s of this.samples) { if (s.t >= cutoff) { oldest = s; break; } }
    if (!oldest) oldest = this.samples[0] ?? null;
    if (!oldest) return 0;
    const dt = (now - oldest.t) / 1000;
    if (dt <= 0) return 0;
    return (this.totalScanned - oldest.scanned) / dt;
  }

  get speed1m(): number { return this.windowSpeed(60); }
  get speed5m(): number { return this.windowSpeed(300); }
  get avgSpeed(): number {
    const dt = (Date.now() - this.start) / 1000;
    return dt > 0 ? this.totalScanned / dt : 0;
  }
  get max(): number { return this.maxSpeed; }
  get total(): number { return this.totalScanned; }
  get uptimeSec(): number { return (Date.now() - this.start) / 1000; }

  snapshot() {
    return {
      total: this.total,
      speed1m: this.speed1m,
      speed5m: this.speed5m,
      avg: this.avgSpeed,
      max: this.max,
      uptimeSec: this.uptimeSec,
    };
  }
}

export function fmtSpeed(keysPerSec: number): string {
  if (keysPerSec >= 1e9) return (keysPerSec / 1e9).toFixed(2) + " Gkey/s";
  if (keysPerSec >= 1e6) return (keysPerSec / 1e6).toFixed(2) + " Mkey/s";
  if (keysPerSec >= 1e3) return (keysPerSec / 1e3).toFixed(2) + " Kkey/s";
  return keysPerSec.toFixed(0) + " key/s";
}

/** Human-readable duration for very large second counts (handles years). */
export function fmtDuration(seconds: number): string {
  if (!isFinite(seconds)) return "∞";
  const yr = 365.25 * 24 * 3600;
  if (seconds >= yr) {
    const years = seconds / yr;
    if (years >= 1e9) return (years / 1e9).toExponential(2) + " billion yr";
    if (years >= 1e6) return (years / 1e6).toFixed(2) + " million yr";
    if (years >= 1e3) return (years / 1e3).toFixed(1) + "k yr";
    return years.toFixed(1) + " yr";
  }
  if (seconds >= 86400) return (seconds / 86400).toFixed(1) + " d";
  if (seconds >= 3600) return (seconds / 3600).toFixed(1) + " h";
  if (seconds >= 60) return (seconds / 60).toFixed(1) + " min";
  return seconds.toFixed(1) + " s";
}
