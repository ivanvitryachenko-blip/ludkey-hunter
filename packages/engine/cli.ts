// LudKey Hunter CPU CLI — a real, runnable search program.
//
// Usage:
//   node --experimental-strip-types cli.ts [--puzzle 71] [--start HEX] [--end HEX]
//        [--window 1024] [--checkpoint path.json] [--demo SECRET_HEX]
//
// --demo hides a known key inside a tiny range so you can watch the program
// actually FIND and report it (proves the pipeline without waiting eons).
//
// Progress is checkpointed; re-running resumes. Ctrl-C saves and exits cleanly.

import { CpuEngine } from "./src/cpuEngine.ts";
import { SpeedTracker, fmtSpeed, fmtDuration } from "./src/stats.ts";
import { saveCheckpoint, loadCheckpoint, type Checkpoint } from "./src/checkpoint.ts";
import { PUZZLE_72, getTargetHash160 } from "../core/src/puzzle.ts";
import { scalarMulG, compressedPubkey } from "../core/src/secp256k1.ts";
import { sha256 } from "../core/src/sha256.ts";
import { ripemd160 } from "../core/src/ripemd160.ts";
import { bytesToHex, hexToBytes, pointToAddressCompressed } from "../core/src/address.ts";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : def;
}

const windowSize = Number(arg("window", "1024"));
const cpPath = arg("checkpoint", "./ludkey-checkpoint.json")!;
const demo = arg("demo");
const payout = arg("payout") || process.env.LUDKEY_PAYOUT;       // your address to auto-sweep to
const doBroadcast = process.argv.includes("--broadcast");         // public broadcast (opt-in)

let rangeStart = PUZZLE_72.rangeStart;
let rangeEnd = PUZZLE_72.rangeEnd;
let target: Uint8Array;
let demoSecret: bigint | null = null;

if (demo) {
  demoSecret = BigInt("0x" + demo.replace(/^0x/, ""));
  // Build a small range around the secret so the demo finds it quickly.
  rangeStart = demoSecret - 5000n;
  rangeEnd = demoSecret + 5000n;
  const p = scalarMulG(demoSecret);
  target = ripemd160(sha256(compressedPubkey(p)));
  console.log(`DEMO MODE: hidden key 0x${demoSecret.toString(16)} inside [0x${rangeStart.toString(16)}, 0x${rangeEnd.toString(16)}]`);
  console.log(`DEMO target address = ${pointToAddressCompressed(p)}\n`);
} else {
  const s = arg("start"); const e = arg("end");
  if (s) rangeStart = BigInt("0x" + s.replace(/^0x/, ""));
  if (e) rangeEnd = BigInt("0x" + e.replace(/^0x/, ""));
  target = getTargetHash160();
  console.log(`LudKey Hunter — Puzzle #${PUZZLE_72.number}`);
  console.log(`  target address = ${PUZZLE_72.address}`);
  console.log(`  target hash160 = ${bytesToHex(target)}`);
  console.log(`  range          = 0x${rangeStart.toString(16)} .. 0x${rangeEnd.toString(16)}\n`);
}

// Resume from checkpoint if it matches this range.
let startFrom = rangeStart;
const existing = loadCheckpoint(cpPath);
if (existing && !demo &&
    BigInt(existing.rangeStart) === rangeStart && BigInt(existing.rangeEnd) === rangeEnd) {
  startFrom = BigInt(existing.position);
  console.log(`Resuming from checkpoint at 0x${startFrom.toString(16)} (scanned ${existing.scanned} so far)\n`);
}

const eng = new CpuEngine({ rangeStart, rangeEnd, target, windowSize, compressed: true, startFrom });
const tracker = new SpeedTracker();
let baseScanned = existing && !demo ? Number(existing.scanned) : 0;

function writeCp(found?: { key: bigint; hash160: Uint8Array }) {
  const cp: Checkpoint = {
    puzzle: PUZZLE_72.number,
    rangeStart: "0x" + rangeStart.toString(16),
    rangeEnd: "0x" + rangeEnd.toString(16),
    position: "0x" + eng.position.toString(16),
    scanned: String(baseScanned + Number(eng.scanned)),
    compressed: true,
    updatedAt: new Date().toISOString(),
    found: found ? { key: "0x" + found.key.toString(16), hash160: bytesToHex(found.hash160) } : undefined,
  };
  saveCheckpoint(cpPath, cp);
}

let stop = false;
process.on("SIGINT", () => { stop = true; });

let lastPrint = 0, lastCp = 0;
console.log("Searching... (Ctrl-C to save & stop)\n");

while (!eng.done && !stop) {
  const found = eng.step();
  const now = Date.now();

  if (found) {
    console.log("\n\n*** MATCH FOUND ***");
    console.log(`  private key = 0x${found.key.toString(16)}`);
    console.log(`  hash160     = ${bytesToHex(found.hash160)}`);
    console.log(`  address     = ${pointToAddressCompressed(scalarMulG(found.key))}`);
    writeCp(found);
    // Written to the local checkpoint only — never transmitted anywhere.
    console.log(`\n  Saved to ${cpPath}. KEEP THIS PRIVATE.`);
    if (payout) {
      try {
        const { claim } = await import("../claim/src/claim.ts");
        await claim(found.key, { destAddress: payout, broadcast: doBroadcast });
      } catch (e) { console.log("claim error:", (e as Error).message, "\nYour key is saved above — import it manually."); }
    } else {
      console.log("\n  Tip: add --payout <your BTC address> (and optionally --broadcast) to");
      console.log("  auto-build a signed sweep to your wallet on a find.");
    }
    process.exit(0);
  }

  if (now - lastPrint >= 1000) {
    tracker.update(baseScanned + Number(eng.scanned));
    const s = tracker.snapshot();
    const remaining = Number(rangeEnd - eng.position);
    const eta = s.avg > 0 ? remaining / s.avg : Infinity;
    process.stdout.write(
      `\r  ${fmtSpeed(s.avg)} | scanned ${s.total.toLocaleString()} | pos 0x${eng.position.toString(16)} | ETA ${fmtDuration(eta)}   `
    );
    lastPrint = now;
  }
  if (now - lastCp >= 5000) { writeCp(); lastCp = now; }
}

writeCp();
console.log(`\n\nStopped. Progress saved to ${cpPath}.`);
if (eng.done) console.log("Range fully scanned; no match in this range.");
