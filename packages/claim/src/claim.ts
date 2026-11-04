// Claim orchestration: when a key is found, fetch the puzzle address's UTXOs,
// build a signed sweep to YOUR address, and (optionally) broadcast it.
//
// SAFE BY DEFAULT: this builds and SIGNS the transaction locally (your key never
// leaves the machine) but does NOT broadcast unless you explicitly opt in. The
// reason is the single most important fact about claiming a famous puzzle prize:
//
//   *** FRONT-RUNNING RISK ***
//   Puzzle addresses are watched by bots. A naive broadcast to the public
//   mempool can be observed and a competing transaction can be mined first,
//   costing you the prize. The safer path (what Krackpot does) is to submit the
//   signed transaction PRIVATELY — directly to a mining pool / transaction
//   accelerator — instead of the public mempool. This tool therefore prints the
//   signed raw transaction so you can submit it privately, and only broadcasts
//   publicly when you pass broadcast:true knowingly.

import { writeFileSync } from "node:fs";
import { scalarMulG, compressedPubkey } from "../../core/src/secp256k1.ts";
import { sha256 } from "../../core/src/sha256.ts";
import { ripemd160 } from "../../core/src/ripemd160.ts";
import { hash160ToAddress } from "../../core/src/address.ts";
import { toWIF } from "./wif.ts";
import { buildSweep, type Utxo } from "./tx.ts";

export interface ClaimOptions {
  destAddress: string;              // YOUR payout address (1... or bc1q...)
  apiBase?: string;                 // explorer API (default mempool.space)
  feerate?: number;                 // sat/vB; if omitted, fetched from the API
  broadcast?: boolean;              // public broadcast (default false = print only)
  outFile?: string;                 // where to save the signed tx + WIF
}

function addressForKey(privkey: bigint): string {
  const h = ripemd160(sha256(compressedPubkey(scalarMulG(privkey))));
  return hash160ToAddress(h);
}

async function fetchUtxos(address: string, apiBase: string): Promise<Utxo[]> {
  const r = await fetch(`${apiBase}/api/address/${address}/utxo`);
  if (!r.ok) throw new Error(`UTXO fetch failed: ${r.status}`);
  const arr = (await r.json()) as { txid: string; vout: number; value: number }[];
  return arr.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value }));
}
async function fetchFeerate(apiBase: string): Promise<number> {
  try { const r = await fetch(`${apiBase}/api/v1/fees/recommended`); const j = await r.json(); return Math.max(2, j.fastestFee || j.halfHourFee || 20); }
  catch { return 25; }
}
async function broadcastTx(rawHex: string, apiBase: string): Promise<string> {
  const r = await fetch(`${apiBase}/api/tx`, { method: "POST", body: rawHex });
  const body = await r.text();
  if (!r.ok) throw new Error(`broadcast failed: ${r.status} ${body}`);
  return body; // returns txid
}

/**
 * Attempt to claim the funds for a found key. Returns a result object; never
 * throws for the normal "built but not broadcast" path.
 */
export async function claim(privkey: bigint, opts: ClaimOptions) {
  const apiBase = opts.apiBase || "https://mempool.space";
  const source = addressForKey(privkey);
  const wif = toWIF(privkey, true);
  const outFile = opts.outFile || `./CLAIM_${source}.json`;

  console.log("\n========================= CLAIM =========================");
  console.log(`found key address : ${source}`);
  console.log(`private key (WIF) : ${wif}   <-- import this into any wallet`);
  console.log(`payout to         : ${opts.destAddress}`);

  let utxos: Utxo[] = [];
  try { utxos = await fetchUtxos(source, apiBase); }
  catch (e) {
    console.log(`\n[!] Could not fetch UTXOs (${(e as Error).message}).`);
    console.log(`    Your key is safe in ${outFile}. Import the WIF above into a wallet to claim manually.`);
    writeFileSync(outFile, JSON.stringify({ source, wif, destAddress: opts.destAddress, note: "UTXO fetch failed; import WIF manually" }, null, 2));
    return { built: false, wif, source };
  }
  if (utxos.length === 0) {
    console.log("\n[!] No UTXOs at the address (already spent?). Nothing to sweep.");
    writeFileSync(outFile, JSON.stringify({ source, wif, destAddress: opts.destAddress, note: "no UTXOs" }, null, 2));
    return { built: false, wif, source };
  }

  const feerate = opts.feerate || (await fetchFeerate(apiBase));
  const sweep = buildSweep(privkey, utxos, opts.destAddress, feerate);
  console.log(`\nbuilt + SIGNED sweep:`);
  console.log(`  inputs     : ${sweep.inputs}`);
  console.log(`  total in   : ${sweep.totalIn} sat`);
  console.log(`  fee        : ${sweep.fee} sat (${feerate} sat/vB)`);
  console.log(`  payout     : ${sweep.outValue} sat -> ${opts.destAddress}`);
  console.log(`  txid       : ${sweep.txid}`);

  writeFileSync(outFile, JSON.stringify({ source, wif, destAddress: opts.destAddress, ...sweep }, null, 2));
  console.log(`\nsigned transaction + WIF saved to ${outFile}`);

  if (!opts.broadcast) {
    console.log("\n[SAFE MODE] Not broadcast. Recommended: submit the raw tx PRIVATELY");
    console.log("to a mining pool / accelerator to avoid front-running, or broadcast");
    console.log("yourself once you understand the risk. Raw transaction:\n");
    console.log(sweep.rawHex);
    return { built: true, broadcast: false, ...sweep, wif };
  }

  console.log("\n[!] Broadcasting PUBLICLY (front-running risk). Submitting...");
  try {
    const txid = await broadcastTx(sweep.rawHex, apiBase);
    console.log(`broadcast ok, txid: ${txid}`);
    return { built: true, broadcast: true, broadcastTxid: txid, ...sweep, wif };
  } catch (e) {
    console.log(`broadcast error: ${(e as Error).message}`);
    console.log(`Raw tx is saved in ${outFile}; submit it manually.`);
    return { built: true, broadcast: false, error: (e as Error).message, ...sweep, wif };
  }
}
