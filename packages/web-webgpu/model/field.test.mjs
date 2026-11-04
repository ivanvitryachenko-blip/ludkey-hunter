import { fromBig, toBig, addMod, subMod, mulMod, invMod, P } from "./field.mjs";
const p = (1n<<256n) - (1n<<32n) - 977n;
let pass=0, fail=0;
const ck=(n,c)=>{ c?pass++:fail++; if(!c) console.log("  FAIL",n); };
function rnd(){ let x=0n; for(let i=0;i<16;i++) x=(x<<16n)|BigInt(Math.floor(Math.random()*65536)); return x % p; }
ck("P round-trips", toBig(P)===p);
for(let i=0;i<2000;i++){
  const a=rnd(), b=rnd();
  if(toBig(addMod(fromBig(a),fromBig(b))) !== (a+b)%p){ ck("add",false); break; }
  if(toBig(subMod(fromBig(a),fromBig(b))) !== ((a-b)%p+p)%p){ ck("sub",false); break; }
  if(toBig(mulMod(fromBig(a),fromBig(b))) !== (a*b)%p){ ck("mul "+a+" "+b,false); break; }
}
ck("add 2000 random", true); ck("sub 2000 random", true); ck("mul 2000 random", true);
// edge cases
ck("mul by 0", toBig(mulMod(fromBig(rnd()),fromBig(0n)))===0n);
ck("mul (p-1)^2", toBig(mulMod(fromBig(p-1n),fromBig(p-1n)))===(p-1n)*(p-1n)%p);
ck("mul max*max", toBig(mulMod(fromBig((1n<<256n)-1n),fromBig((1n<<256n)-1n)))===(( (1n<<256n)-1n)%p*(((1n<<256n)-1n)%p))%p);
// inverse
for(let i=0;i<20;i++){ const a=rnd(); const inv=toBig(invMod(fromBig(a))); if((a*inv)%p!==1n){ ck("inv",false); break; } }
ck("inv 20 random (a*a^-1==1)", true);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
