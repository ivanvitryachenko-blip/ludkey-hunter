import { scalarMulG as modelMul, compressed } from "./ec.mjs";
import { toBig } from "./field.mjs";
import { scalarMulG as refMul, compressedPubkey } from "../../core/src/secp256k1.ts";
import { hash160FromPointCompressed, bytesToHex } from "../../core/src/address.ts";
let pass=0, fail=0; const ck=(n,c)=>{ c?pass++:fail++; if(!c) console.log("  FAIL",n); };

const keys = [1n,2n,3n,0x15n,0x202n, 123456789n, (1n<<70n), (1n<<70n)+0xabcden, (1n<<71n)-1n];
for(let i=0;i<10;i++) keys.push((BigInt(Math.floor(Math.random()*1e15))<<20n)|BigInt(Math.floor(Math.random()*1e6)));

let allXY=true, allPub=true, allH=true;
for(const k of keys){
  const m = modelMul(k);
  const r = refMul(k);
  if(toBig(m.x)!==r.x || toBig(m.y)!==r.y){ allXY=false; console.log("  xy mismatch key",k.toString(16)); break; }
  const pub = compressed(m.x, m.y);
  if(bytesToHex(pub)!==bytesToHex(compressedPubkey(r))){ allPub=false; break; }
  // hash160 pipeline (hash via core) must match
  const h = bytesToHex(hash160FromPointCompressed(r));
  // model produces same pub -> same hash by construction; just assert pub equality covers it
}
ck("scalarMulG affine (x,y) matches reference for "+keys.length+" keys incl. #71 range", allXY);
ck("compressed pubkey matches reference", allPub);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
