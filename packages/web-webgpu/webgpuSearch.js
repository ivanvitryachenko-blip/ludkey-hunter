// LudKey Hunter — WebGPU full search kernel (browser GPU acceleration).
//
// The field + EC routines are a direct transliteration of the model in
// packages/web-webgpu/model/*.mjs, which is verified byte-for-byte against the
// tested CPU core. SHA-256 and RIPEMD-160 mirror the tested implementations.
// Correctness on a given GPU is still gated by an on-device self-test (hash160
// of known keys vs known values); if it fails, callers fall back to CPU.

export const SEARCH_WGSL = /* wgsl */ `
var<private> P: array<u32,16>   = array<u32,16>(0xfc2fu,0xffffu,0xfffeu,0xffffu,0xffffu,0xffffu,0xffffu,0xffffu,0xffffu,0xffffu,0xffffu,0xffffu,0xffffu,0xffffu,0xffffu,0xffffu);
var<private> PM2: array<u32,16> = array<u32,16>(0xfc2du,0xffffu,0xfffeu,0xffffu,0xffffu,0xffffu,0xffffu,0xffffu,0xffffu,0xffffu,0xffffu,0xffffu,0xffffu,0xffffu,0xffffu,0xffffu);

fn ge_p(a: array<u32,16>) -> bool {
  for (var i: i32 = 15; i >= 0; i = i - 1) { if (a[i] != P[i]) { return a[i] > P[i]; } }
  return true;
}
fn addMod(a: array<u32,16>, b: array<u32,16>) -> array<u32,16> {
  var r: array<u32,16>; var carry: u32 = 0u;
  for (var i=0; i<16; i=i+1) { let s = a[i] + b[i] + carry; r[i] = s & 0xffffu; carry = s >> 16u; }
  if (carry != 0u || ge_p(r)) { var br: u32 = 0u; for (var i=0;i<16;i=i+1){ let d = (r[i] | 0x10000u) - P[i] - br; r[i] = d & 0xffffu; br = 1u - (d >> 16u); } }
  return r;
}
fn subMod(a: array<u32,16>, b: array<u32,16>) -> array<u32,16> {
  var r: array<u32,16>; var br: u32 = 0u;
  for (var i=0;i<16;i=i+1){ let d = (a[i] | 0x10000u) - b[i] - br; r[i] = d & 0xffffu; br = 1u - (d >> 16u); }
  if (br != 0u) { var c: u32 = 0u; for (var i=0;i<16;i=i+1){ let s = r[i] + P[i] + c; r[i] = s & 0xffffu; c = s >> 16u; } }
  return r;
}
fn reduce(t_in: array<u32,32>) -> array<u32,16> {
  var t = t_in;
  for (var pass=0; pass<3; pass=pass+1) {
    var c: array<u32,16>;
    for (var i=0;i<16;i=i+1){ c[i] = t[16+i]; t[16+i] = 0u; }
    var carry: u32 = 0u;
    for (var i=0;i<16;i=i+1){ let cur = t[i] + c[i]*977u + carry; t[i] = cur & 0xffffu; carry = cur >> 16u; }
    t[16] = t[16] + carry;
    carry = 0u;
    for (var i=0;i<16;i=i+1){ let cur = t[i+2] + c[i] + carry; t[i+2] = cur & 0xffffu; carry = cur >> 16u; }
    t[18] = t[18] + carry;
  }
  var r: array<u32,16>;
  for (var i=0;i<16;i=i+1){ r[i] = t[i] & 0xffffu; }
  for (var g=0; g<8; g=g+1){ if (ge_p(r)) { var br: u32 = 0u; for (var i=0;i<16;i=i+1){ let d = (r[i]|0x10000u) - P[i] - br; r[i] = d & 0xffffu; br = 1u - (d>>16u); } } }
  return r;
}
fn mulMod(a: array<u32,16>, b: array<u32,16>) -> array<u32,16> {
  var t: array<u32,32>;
  for (var i=0;i<32;i=i+1){ t[i] = 0u; }
  for (var i=0;i<16;i=i+1){
    var carry: u32 = 0u;
    for (var j=0;j<16;j=j+1){ let cur = t[i+j] + a[i]*b[j] + carry; t[i+j] = cur & 0xffffu; carry = cur >> 16u; }
    t[i+16] = carry;
  }
  return reduce(t);
}
fn sqrMod(a: array<u32,16>) -> array<u32,16> { return mulMod(a,a); }
fn invMod(a: array<u32,16>) -> array<u32,16> {
  var result: array<u32,16>; result[0]=1u; for (var i=1;i<16;i=i+1){ result[i]=0u; }
  var base = a;
  for (var bit=0; bit<256; bit=bit+1){
    if (((PM2[bit >> 4] >> (u32(bit) & 15u)) & 1u) == 1u) { result = mulMod(result, base); }
    base = sqrMod(base);
  }
  return result;
}
fn isZero(a: array<u32,16>) -> bool { for (var i=0;i<16;i=i+1){ if (a[i] != 0u) { return false; } } return true; }

struct Jac { X: array<u32,16>, Y: array<u32,16>, Z: array<u32,16>, };

fn jdouble(Pt: Jac) -> Jac {
  var R: Jac;
  if (isZero(Pt.Z) || isZero(Pt.Y)) { var one: array<u32,16>; one[0]=1u; for(var i=1;i<16;i=i+1){one[i]=0u;} var z: array<u32,16>; R.X=one; R.Y=one; R.Z=z; return R; }
  var three: array<u32,16>; three[0]=3u; for(var i=1;i<16;i=i+1){three[i]=0u;}
  var eight: array<u32,16>; eight[0]=8u; for(var i=1;i<16;i=i+1){eight[i]=0u;}
  let A = sqrMod(Pt.X); let B = sqrMod(Pt.Y); let C = sqrMod(B);
  var t = addMod(Pt.X, B); t = sqrMod(t); t = subMod(t, A); t = subMod(t, C);
  let D = addMod(t, t);
  let E = mulMod(three, A);
  let F = sqrMod(E);
  let X3 = subMod(F, addMod(D, D));
  let Y3 = subMod(mulMod(E, subMod(D, X3)), mulMod(eight, C));
  let Z3 = mulMod(addMod(Pt.Y, Pt.Y), Pt.Z);
  R.X = X3; R.Y = Y3; R.Z = Z3; return R;
}
fn jadd(Pt: Jac, Q: Jac) -> Jac {
  var R: Jac;
  if (isZero(Pt.Z)) { return Q; }
  if (isZero(Q.Z)) { return Pt; }
  let Z1 = sqrMod(Pt.Z); let Z2 = sqrMod(Q.Z);
  let U1 = mulMod(Pt.X, Z2); let U2 = mulMod(Q.X, Z1);
  let S1 = mulMod(mulMod(Pt.Y, Q.Z), Z2); let S2 = mulMod(mulMod(Q.Y, Pt.Z), Z1);
  let du = subMod(U2, U1); let ds = subMod(S2, S1);
  if (isZero(du)) { if (!isZero(ds)) { var one: array<u32,16>; one[0]=1u; for(var i=1;i<16;i=i+1){one[i]=0u;} var z: array<u32,16>; R.X=one; R.Y=one; R.Z=z; return R; } return jdouble(Pt); }
  let H = du;
  let I = sqrMod(addMod(H, H));
  let J = mulMod(H, I);
  let r = addMod(ds, ds);
  let V = mulMod(U1, I);
  let X3 = subMod(subMod(sqrMod(r), J), addMod(V, V));
  let Y3 = subMod(mulMod(r, subMod(V, X3)), addMod(mulMod(S1, J), mulMod(S1, J)));
  var Z3 = subMod(subMod(sqrMod(addMod(Pt.Z, Q.Z)), Z1), Z2);
  Z3 = mulMod(Z3, H);
  R.X = X3; R.Y = Y3; R.Z = Z3; return R;
}

// key (16 limbs) -> affine x,y
fn scalarMulG(key: array<u32,16>) -> array<u32,32> {
  var Gx: array<u32,16> = array<u32,16>(0x1798u,0x16f8u,0x815bu,0x59f2u,0x28d9u,0x2dceu,0xfcdbu,0x029bu,0x0b07u,0xce87u,0x6295u,0x55a0u,0xbbacu,0xf9dcu,0x667eu,0x79beu);
  var Gy: array<u32,16> = array<u32,16>(0xd4b8u,0xfb10u,0xd08fu,0x9c47u,0x5419u,0xa685u,0xb448u,0xfd17u,0x08a8u,0x0e11u,0xfbfcu,0x5da4u,0xc465u,0x26a3u,0xda77u,0x483au);
  var acc: Jac; var one: array<u32,16>; one[0]=1u; for(var i=1;i<16;i=i+1){one[i]=0u;}
  var z0: array<u32,16>; acc.X = one; acc.Y = one; acc.Z = z0;
  var add: Jac; add.X = Gx; add.Y = Gy; add.Z = one;
  for (var bit=0; bit<256; bit=bit+1){
    if (((key[bit >> 4] >> (u32(bit) & 15u)) & 1u) == 1u) { acc = jadd(acc, add); }
    add = jdouble(add);
  }
  let zi = invMod(acc.Z);
  let zi2 = sqrMod(zi); let zi3 = mulMod(zi2, zi);
  let x = mulMod(acc.X, zi2); let y = mulMod(acc.Y, zi3);
  var out: array<u32,32>;
  for (var i=0;i<16;i=i+1){ out[i] = x[i]; out[16+i] = y[i]; }
  return out;
}
` + SHA256_RIPEMD_WGSL();

function SHA256_RIPEMD_WGSL() { return /* wgsl */ `
// ---- SHA-256 (one block, msg<=55 bytes) over a byte array in a 64-u32 buffer ----
var<private> SK: array<u32,64> = array<u32,64>(
0x428a2f98u,0x71374491u,0xb5c0fbcfu,0xe9b5dba5u,0x3956c25bu,0x59f111f1u,0x923f82a4u,0xab1c5ed5u,
0xd807aa98u,0x12835b01u,0x243185beu,0x550c7dc3u,0x72be5d74u,0x80deb1feu,0x9bdc06a7u,0xc19bf174u,
0xe49b69c1u,0xefbe4786u,0x0fc19dc6u,0x240ca1ccu,0x2de92c6fu,0x4a7484aau,0x5cb0a9dcu,0x76f988dau,
0x983e5152u,0xa831c66du,0xb00327c8u,0xbf597fc7u,0xc6e00bf3u,0xd5a79147u,0x06ca6351u,0x14292967u,
0x27b70a85u,0x2e1b2138u,0x4d2c6dfcu,0x53380d13u,0x650a7354u,0x766a0abbu,0x81c2c92eu,0x92722c85u,
0xa2bfe8a1u,0xa81a664bu,0xc24b8b70u,0xc76c51a3u,0xd192e819u,0xd6990624u,0xf40e3585u,0x106aa070u,
0x19a4c116u,0x1e376c08u,0x2748774cu,0x34b0bcb5u,0x391c0cb3u,0x4ed8aa4au,0x5b9cca4fu,0x682e6ff3u,
0x748f82eeu,0x78a5636fu,0x84c87814u,0x8cc70208u,0x90befffau,0xa4506cebu,0xbef9a3f7u,0xc67178f2u);
fn rotr(x: u32, n: u32) -> u32 { return (x >> n) | (x << (32u - n)); }

// hashes the 33-byte compressed pubkey in bytes[0..33], returns 8 u32 (big-endian words)
fn sha256_33(bytes: array<u32,64>) -> array<u32,8> {
  var w: array<u32,64>;
  // build padded block: 33 bytes + 0x80 + zeros + len(264 bits) in last 8 bytes; one 64-byte block
  var b: array<u32,64>;
  for (var i=0;i<64;i=i+1){ b[i] = 0u; }
  for (var i=0;i<33;i=i+1){ b[i] = bytes[i] & 0xffu; }
  b[33] = 0x80u;
  b[62] = 1u; b[63] = 8u; // 264 = 0x108
  for (var i=0;i<16;i=i+1){ let j=i*4; w[i] = (b[j]<<24u)|(b[j+1]<<16u)|(b[j+2]<<8u)|b[j+3]; }
  for (var i=16;i<64;i=i+1){
    let s0 = rotr(w[i-15],7u) ^ rotr(w[i-15],18u) ^ (w[i-15] >> 3u);
    let s1 = rotr(w[i-2],17u) ^ rotr(w[i-2],19u) ^ (w[i-2] >> 10u);
    w[i] = w[i-16] + s0 + w[i-7] + s1;
  }
  var a=0x6a09e667u; var bb=0xbb67ae85u; var c=0x3c6ef372u; var d=0xa54ff53au;
  var e=0x510e527fu; var f=0x9b05688cu; var g=0x1f83d9abu; var h=0x5be0cd19u;
  for (var i=0;i<64;i=i+1){
    let S1 = rotr(e,6u)^rotr(e,11u)^rotr(e,25u);
    let ch = (e & f) ^ ((~e) & g);
    let t1 = h + S1 + ch + SK[i] + w[i];
    let S0 = rotr(a,2u)^rotr(a,13u)^rotr(a,22u);
    let maj = (a & bb) ^ (a & c) ^ (bb & c);
    let t2 = S0 + maj;
    h=g; g=f; f=e; e=d+t1; d=c; c=bb; bb=a; a=t1+t2;
  }
  var H: array<u32,8>;
  H[0]=0x6a09e667u+a; H[1]=0xbb67ae85u+bb; H[2]=0x3c6ef372u+c; H[3]=0xa54ff53au+d;
  H[4]=0x510e527fu+e; H[5]=0x9b05688cu+f; H[6]=0x1f83d9abu+g; H[7]=0x5be0cd19u+h;
  return H;
}

// ---- RIPEMD-160 over the 32-byte sha256 digest ----
var<private> RL: array<u32,80> = array<u32,80>(0u,1u,2u,3u,4u,5u,6u,7u,8u,9u,10u,11u,12u,13u,14u,15u,7u,4u,13u,1u,10u,6u,15u,3u,12u,0u,9u,5u,2u,14u,11u,8u,3u,10u,14u,4u,9u,15u,8u,1u,2u,7u,0u,6u,13u,11u,5u,12u,1u,9u,11u,10u,0u,8u,12u,4u,13u,3u,7u,15u,14u,5u,6u,2u,4u,0u,5u,9u,7u,12u,2u,10u,14u,1u,3u,8u,11u,6u,15u,13u);
var<private> RR: array<u32,80> = array<u32,80>(5u,14u,7u,0u,9u,2u,11u,4u,13u,6u,15u,8u,1u,10u,3u,12u,6u,11u,3u,7u,0u,13u,5u,10u,14u,15u,8u,12u,4u,9u,1u,2u,15u,5u,1u,3u,7u,14u,6u,9u,11u,8u,12u,2u,10u,0u,4u,13u,8u,6u,4u,1u,3u,11u,15u,0u,5u,12u,2u,13u,9u,7u,10u,14u,12u,15u,10u,4u,1u,5u,8u,7u,6u,2u,13u,14u,0u,3u,9u,11u);
var<private> SLc: array<u32,80> = array<u32,80>(11u,14u,15u,12u,5u,8u,7u,9u,11u,13u,14u,15u,6u,7u,9u,8u,7u,6u,8u,13u,11u,9u,7u,15u,7u,12u,15u,9u,11u,7u,13u,12u,11u,13u,6u,7u,14u,9u,13u,15u,14u,8u,13u,6u,5u,12u,7u,5u,11u,12u,14u,15u,14u,15u,9u,8u,9u,14u,5u,6u,8u,6u,5u,12u,9u,15u,5u,11u,6u,8u,13u,12u,5u,12u,13u,14u,11u,8u,5u,6u);
var<private> SRc: array<u32,80> = array<u32,80>(8u,9u,9u,11u,13u,15u,15u,5u,7u,7u,8u,11u,14u,14u,12u,6u,9u,13u,15u,7u,12u,8u,9u,11u,7u,7u,12u,7u,6u,15u,13u,11u,9u,7u,15u,11u,8u,6u,6u,14u,12u,13u,5u,14u,13u,13u,7u,5u,15u,5u,8u,11u,14u,14u,6u,14u,6u,9u,12u,9u,12u,5u,15u,8u,8u,5u,12u,9u,12u,5u,14u,6u,8u,13u,6u,5u,15u,13u,11u,11u);
var<private> KLc: array<u32,5> = array<u32,5>(0x00000000u,0x5a827999u,0x6ed9eba1u,0x8f1bbcdcu,0xa953fd4eu);
var<private> KRc: array<u32,5> = array<u32,5>(0x50a28be6u,0x5c4dd124u,0x6d703ef3u,0x7a6d76e9u,0x00000000u);
fn rol(x: u32, n: u32) -> u32 { return (x << n) | (x >> (32u - n)); }
fn rf(j: i32, x: u32, y: u32, z: u32) -> u32 {
  if (j < 16) { return x ^ y ^ z; }
  if (j < 32) { return (x & y) | ((~x) & z); }
  if (j < 48) { return (x | (~y)) ^ z; }
  if (j < 64) { return (x & z) | (y & (~z)); }
  return x ^ (y | (~z));
}
// sha digest H (8 big-endian words) -> 20-byte hash160 as 5 little-endian words
fn ripemd160(H: array<u32,8>) -> array<u32,5> {
  var X: array<u32,16>;
  // message = the 32-byte SHA-256 digest (big-endian per word), packed into 8
  // little-endian 32-bit words X[0..7]; then standard padding.
  for (var i=0;i<8;i=i+1){
    let be = H[i];
    let b0 = (be >> 24u) & 0xffu; let b1 = (be >> 16u) & 0xffu; let b2 = (be >> 8u) & 0xffu; let b3 = be & 0xffu;
    X[i] = b0 | (b1<<8u) | (b2<<16u) | (b3<<24u);
  }
  X[8] = 0x80u;          // padding byte after 32 bytes
  for (var i=9;i<16;i=i+1){ X[i] = 0u; }
  X[14] = 256u;          // bit length = 32*8 = 256, little-endian low word
  X[15] = 0u;
  var h0=0x67452301u; var h1=0xefcdab89u; var h2=0x98badcfeu; var h3=0x10325476u; var h4=0xc3d2e1f0u;
  var al=h0; var bl=h1; var cl=h2; var dl=h3; var el=h4;
  var ar=h0; var br=h1; var cr=h2; var dr=h3; var er=h4;
  for (var j=0;j<80;j=j+1){
    let rnd = j/16;
    var t = al + rf(j, bl, cl, dl) + X[RL[j]] + KLc[rnd]; t = rol(t, SLc[j]) + el; al=el; el=dl; dl=rol(cl,10u); cl=bl; bl=t;
    let jr = 79 - j;
    var tr = ar + rf(jr, br, cr, dr) + X[RR[j]] + KRc[rnd]; tr = rol(tr, SRc[j]) + er; ar=er; er=dr; dr=rol(cr,10u); cr=br; br=tr;
  }
  var R: array<u32,5>;
  let t = h1 + cl + dr; R[1] = h2 + dl + er; R[2] = h3 + el + ar; R[3] = h4 + al + br; R[4] = h0 + bl + cr; R[0] = t;
  return R;
}

@group(0) @binding(0) var<storage, read> params: array<u32>;      // [baseKey 16][target 5 (le words)][count_lo]
@group(0) @binding(1) var<storage, read_write> result: array<atomic<u32>>; // [found_flag, found_lo, found_hi]

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let tid = gid.x;
  let count = params[21];
  if (tid >= count) { return; }
  // key = base + tid
  var key: array<u32,16>;
  for (var i=0;i<16;i=i+1){ key[i] = params[i]; }
  var add = tid; var idx = 0;
  loop {
    if (add == 0u || idx >= 16) { break; }
    let s = key[idx] + (add & 0xffffu);
    key[idx] = s & 0xffffu;
    add = (add >> 16u) + (s >> 16u);
    idx = idx + 1;
  }
  let xy = scalarMulG(key);
  // compressed pubkey bytes: prefix + big-endian x (x is limbs 0..15, little-endian 16-bit)
  var pub: array<u32,64>;
  for (var i=0;i<64;i=i+1){ pub[i] = 0u; }
  // y parity from y limb 0
  pub[0] = select(0x02u, 0x03u, (xy[16] & 1u) == 1u);
  // x big-endian: most significant limb is x[15]
  for (var i=0;i<16;i=i+1){
    let limb = xy[15 - i];           // 16-bit
    pub[1 + i*2]     = (limb >> 8u) & 0xffu;
    pub[1 + i*2 + 1] = limb & 0xffu;
  }
  let sh = sha256_33(pub);
  let h = ripemd160(sh);
  // compare against target (params[16..20] are hash160 as 5 little-endian 32-bit words)
  var match = true;
  for (var i=0;i<5;i=i+1){ if (h[i] != params[16 + i]) { match = false; } }
  if (match) {
    atomicStore(&result[0], 1u);
    atomicStore(&result[1], tid);
  }
}
`; }

// ---------------- driver ----------------
function keyToLimbs(k) { const o = new Uint32Array(16); for (let i = 0; i < 16; i++) { o[i] = Number(k & 0xffffn); k >>= 16n; } return o; }
function h160ToWords(bytes) { const w = new Uint32Array(5); for (let i = 0; i < 5; i++) w[i] = (bytes[i*4] | (bytes[i*4+1]<<8) | (bytes[i*4+2]<<16) | (bytes[i*4+3]<<24)) >>> 0; return w; }

export class WebGPUSearch {
  constructor() { this.device = null; this.pipeline = null; this.ok = false; }

  async init() {
    if (!("gpu" in navigator)) return { ok: false, reason: "WebGPU not available in this browser" };
    let adapter;
    try { adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" }); }
    catch (e) { return { ok: false, reason: "requestAdapter failed: " + e.message }; }
    if (!adapter) return { ok: false, reason: "no GPU adapter" };
    this.device = await adapter.requestDevice();
    try {
      const module = this.device.createShaderModule({ code: SEARCH_WGSL });
      // surface compile errors early
      if (module.getCompilationInfo) {
        const info = await module.getCompilationInfo();
        const err = info.messages.find(m => m.type === "error");
        if (err) return { ok: false, reason: "WGSL compile error: " + err.message };
      }
      this.pipeline = this.device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
    } catch (e) { return { ok: false, reason: "pipeline creation failed: " + e.message }; }
    this.adapterInfo = adapter.info || {};
    const st = await this.selfTest();
    this.ok = st.ok;
    return st;
  }

  // One batch: test keys base..base+count-1 against targetBytes(20). Returns {found, key} or {found:false}.
  async searchBatch(baseKey, targetBytes, count) {
    const params = new Uint32Array(22);
    params.set(keyToLimbs(baseKey), 0);
    params.set(h160ToWords(targetBytes), 16);
    params[21] = count >>> 0;
    const pbuf = this.device.createBuffer({ size: params.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(pbuf, 0, params);
    const rbuf = this.device.createBuffer({ size: 12, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(rbuf, 0, new Uint32Array([0, 0, 0]));
    const read = this.device.createBuffer({ size: 12, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const bind = this.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: pbuf } }, { binding: 1, resource: { buffer: rbuf } }] });
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipeline); pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(Math.ceil(count / 64));
    pass.end();
    enc.copyBufferToBuffer(rbuf, 0, read, 0, 12);
    this.device.queue.submit([enc.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const out = new Uint32Array(read.getMappedRange().slice(0));
    read.unmap();
    pbuf.destroy(); rbuf.destroy(); read.destroy();
    if (out[0] === 1) return { found: true, key: baseKey + BigInt(out[1] >>> 0) };
    return { found: false };
  }

  // Self-test: the GPU must "find" known keys by their known hash160, and must
  // NOT find a wrong one. Uses the real kernel, so it validates the whole GPU
  // pipeline (field, EC, SHA-256, RIPEMD-160) end to end.
  async selfTest() {
    // (key, hash160) pairs from the tested CPU core.
    const V = [
      [0x1n,   "751e76e8199196d454941c45d1b3a323f1433bd6"],
      [0x15n,  "8f9dff39a81ee4abcbad2ad8bafff090415a2be8"],
      [0x202n, "d7729816650e581d7462d52ad6f732da0e2ec93b"],
    ];
    const hex2b = (h) => { const o = new Uint8Array(20); for (let i = 0; i < 20; i++) o[i] = parseInt(h.substr(i*2,2),16); return o; };
    try {
      for (const [k, h] of V) {
        const r = await this.searchBatch(k, hex2b(h), 1);
        if (!r.found || r.key !== k) return { ok: false, reason: "GPU hash160 mismatch (falling back to CPU)" };
      }
      // negative: searching base=2 for key 1's hash must NOT match
      const neg = await this.searchBatch(0x2n, hex2b(V[0][1]), 1);
      if (neg.found) return { ok: false, reason: "GPU produced a false positive (falling back to CPU)" };
      return { ok: true, reason: "GPU pipeline self-test passed", adapter: this.adapterInfo };
    } catch (e) { return { ok: false, reason: "GPU self-test error: " + e.message }; }
  }
}
