// Honest CPU throughput benchmark. Scans real keys in the puzzle-71 range for a
// fixed wall-clock duration and reports measured keys/sec. No target is expected
// to match — we only measure how fast real candidates are produced and hashed.

import { CpuEngine } from "./src/cpuEngine.ts";
import { fmtSpeed, fmtDuration } from "./src/stats.ts";
import { PUZZLE_72, getTargetHash160, rangeSize } from "../core/src/puzzle.ts";

const seconds = Number(process.argv[2] ?? 5);
const windowSize = Number(process.argv[3] ?? 1024);

const eng = new CpuEngine({
  rangeStart: PUZZLE_72.rangeStart,
  rangeEnd: PUZZLE_72.rangeEnd,
  target: getTargetHash160(), // real #71 target; will not match in a short scan
  windowSize,
  compressed: true,
});

console.log(`Benchmarking CPU engine against real Puzzle #71 target`);
console.log(`  window size = ${windowSize}, duration = ${seconds}s, 1 thread (BigInt reference core)\n`);

const t0 = Date.now();
const deadline = t0 + seconds * 1000;
let windows = 0;
while (Date.now() < deadline) {
  // run a handful of windows between clock checks to reduce timer overhead
  for (let i = 0; i < 20 && Date.now() < deadline; i++) { eng.step(); windows++; }
}
const dt = (Date.now() - t0) / 1000;
const scanned = Number(eng.scanned);
const rate = scanned / dt;

console.log(`  scanned      = ${scanned.toLocaleString()} keys in ${dt.toFixed(2)}s`);
console.log(`  throughput   = ${fmtSpeed(rate)}  (1 CPU thread)`);
console.log(`  per key      = ${(1e6 / rate).toFixed(3)} µs\n`);

// Extrapolate expected time to exhaust 2^70 at this single-thread rate.
const total = Number(rangeSize());
const exhaustSec = total / rate;
console.log(`  #71 keyspace = 2^70 = ${total.toExponential(3)} keys`);
console.log(`  @ this rate, 1 thread to exhaust = ${fmtDuration(exhaustSec)}`);
console.log(`  @ this rate, 50% expected find   = ${fmtDuration(exhaustSec / 2)}`);
