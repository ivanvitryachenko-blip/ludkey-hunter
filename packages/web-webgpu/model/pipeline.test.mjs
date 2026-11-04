// Port of the WGSL kernel's hash stages to JS (same ops/packing), verified
// against the tested core on the full key -> hash160 pipeline.
import { scalarMulG, compressed } from "./ec.mjs";
import { hash160FromPointCompressed, bytesToHex } from "../../core/src/address.ts";
import { scalarMulG as refMul } from "../../core/src/secp256k1.ts";

const SK=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
const rotr=(x,n)=>((x>>>n)|(x<<(32-n)))>>>0;
function sha256_33(bytes){ // bytes: array length>=33
  const b=new Array(64).fill(0); for(let i=0;i<33;i++) b[i]=bytes[i]&0xff; b[33]=0x80; b[62]=1; b[63]=8;
  const w=new Array(64);
  for(let i=0;i<16;i++){const j=i*4;w[i]=((b[j]<<24)|(b[j+1]<<16)|(b[j+2]<<8)|b[j+3])>>>0;}
  for(let i=16;i<64;i++){const s0=rotr(w[i-15],7)^rotr(w[i-15],18)^(w[i-15]>>>3);const s1=rotr(w[i-2],17)^rotr(w[i-2],19)^(w[i-2]>>>10);w[i]=(w[i-16]+s0+w[i-7]+s1)>>>0;}
  let a=0x6a09e667,bb=0xbb67ae85,c=0x3c6ef372,d=0xa54ff53a,e=0x510e527f,f=0x9b05688c,g=0x1f83d9ab,h=0x5be0cd19;
  for(let i=0;i<64;i++){const S1=rotr(e,6)^rotr(e,11)^rotr(e,25),ch=(e&f)^(~e&g),t1=(h+S1+ch+SK[i]+w[i])>>>0,S0=rotr(a,2)^rotr(a,13)^rotr(a,22),maj=(a&bb)^(a&c)^(bb&c),t2=(S0+maj)>>>0;h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=bb;bb=a;a=(t1+t2)>>>0;}
  return [(0x6a09e667+a)>>>0,(0xbb67ae85+bb)>>>0,(0x3c6ef372+c)>>>0,(0xa54ff53a+d)>>>0,(0x510e527f+e)>>>0,(0x9b05688c+f)>>>0,(0x1f83d9ab+g)>>>0,(0x5be0cd19+h)>>>0];
}
const RL=[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,7,4,13,1,10,6,15,3,12,0,9,5,2,14,11,8,3,10,14,4,9,15,8,1,2,7,0,6,13,11,5,12,1,9,11,10,0,8,12,4,13,3,7,15,14,5,6,2,4,0,5,9,7,12,2,10,14,1,3,8,11,6,15,13];
const RR=[5,14,7,0,9,2,11,4,13,6,15,8,1,10,3,12,6,11,3,7,0,13,5,10,14,15,8,12,4,9,1,2,15,5,1,3,7,14,6,9,11,8,12,2,10,0,4,13,8,6,4,1,3,11,15,0,5,12,2,13,9,7,10,14,12,15,10,4,1,5,8,7,6,2,13,14,0,3,9,11];
const SLc=[11,14,15,12,5,8,7,9,11,13,14,15,6,7,9,8,7,6,8,13,11,9,7,15,7,12,15,9,11,7,13,12,11,13,6,7,14,9,13,15,14,8,13,6,5,12,7,5,11,12,14,15,14,15,9,8,9,14,5,6,8,6,5,12,9,15,5,11,6,8,13,12,5,12,13,14,11,8,5,6];
const SRc=[8,9,9,11,13,15,15,5,7,7,8,11,14,14,12,6,9,13,15,7,12,8,9,11,7,7,12,7,6,15,13,11,9,7,15,11,8,6,6,14,12,13,5,14,13,13,7,5,15,5,8,11,14,14,6,14,6,9,12,9,12,5,15,8,8,5,12,9,12,5,14,6,8,13,6,5,15,13,11,11];
const KLc=[0,0x5a827999,0x6ed9eba1,0x8f1bbcdc,0xa953fd4e],KRc=[0x50a28be6,0x5c4dd124,0x6d703ef3,0x7a6d76e9,0];
const rol=(x,n)=>((x<<n)|(x>>>(32-n)))>>>0;
const rf=(j,x,y,z)=>{if(j<16)return(x^y^z)>>>0;if(j<32)return((x&y)|(~x&z))>>>0;if(j<48)return((x|~y)^z)>>>0;if(j<64)return((x&z)|(y&~z))>>>0;return(x^(y|~z))>>>0;};
function ripemd160(H){ // H: 8 big-endian words
  const X=new Array(16).fill(0);
  for(let i=0;i<8;i++){const be=H[i]>>>0;const b0=(be>>>24)&0xff,b1=(be>>>16)&0xff,b2=(be>>>8)&0xff,b3=be&0xff;X[i]=(b0|(b1<<8)|(b2<<16)|(b3<<24))>>>0;}
  X[8]=0x80;X[14]=256;X[15]=0;
  let h0=0x67452301,h1=0xefcdab89,h2=0x98badcfe,h3=0x10325476,h4=0xc3d2e1f0;
  let al=h0,bl=h1,cl=h2,dl=h3,el=h4,ar=h0,br=h1,cr=h2,dr=h3,er=h4;
  for(let j=0;j<80;j++){const rnd=(j/16)|0;let t=(al+rf(j,bl,cl,dl)+X[RL[j]]+KLc[rnd])>>>0;t=(rol(t,SLc[j])+el)>>>0;al=el;el=dl;dl=rol(cl,10);cl=bl;bl=t;const jr=79-j;let tr=(ar+rf(jr,br,cr,dr)+X[RR[j]]+KRc[rnd])>>>0;tr=(rol(tr,SRc[j])+er)>>>0;ar=er;er=dr;dr=rol(cr,10);cr=br;br=tr;}
  const t=(h1+cl+dr)>>>0;const R=[t,(h2+dl+er)>>>0,(h3+el+ar)>>>0,(h4+al+br)>>>0,(h0+bl+cr)>>>0];
  // to 20 bytes little-endian
  const out=new Uint8Array(20);for(let i=0;i<5;i++){out[i*4]=R[i]&0xff;out[i*4+1]=(R[i]>>>8)&0xff;out[i*4+2]=(R[i]>>>16)&0xff;out[i*4+3]=(R[i]>>>24)&0xff;}return out;
}
function kernelHash160(key){ const m=scalarMulG(key); const pub=compressed(m.x,m.y); const H=sha256_33(pub); return ripemd160(H); }

let pass=0,fail=0; const ck=(n,c)=>{c?pass++:fail++; if(!c)console.log("  FAIL",n);};
const keys=[1n,2n,3n,0x15n,0x202n,(1n<<70n),(1n<<70n)+0xabcden,(1n<<71n)-1n,0x40000000000000abcdn];
let all=true;
for(const k of keys){ const got=bytesToHex(kernelHash160(k)); const want=bytesToHex(hash160FromPointCompressed(refMul(k))); if(got!==want){ all=false; console.log("  mismatch key",k.toString(16),"\n   got ",got,"\n   want",want); break; } }
ck("kernel key->hash160 matches core for "+keys.length+" keys (incl #71 target range)", all);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
