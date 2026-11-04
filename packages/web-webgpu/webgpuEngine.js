// LudKey Hunter — WebGPU acceleration module (browser GPU compute).
//
// VALIDATION STATUS: not executed in the authoring environment (no browser GPU
// there). It self-validates on the VIEWER's GPU: before use it hashes known
// inputs on the GPU and compares to known-answer vectors. If WebGPU is missing
// or the self-test fails, callers fall back to the verified CPU Web-Worker
// engine. The standalone web app ships with the CPU engine active for exactly
// this reason — correctness first.
//
// This module provides the SHA-256 stage as a complete, self-testing WGSL
// compute pipeline (the portable, lower-risk building block). The 256-bit
// field + EC stage follows the same structure as the CUDA kernel in
// packages/agent-cuda and is the documented extension for a full GPU pipeline.

const SHA256_WGSL = /* wgsl */ `
const K = array<u32,64>(
  0x428a2f98u,0x71374491u,0xb5c0fbcfu,0xe9b5dba5u,0x3956c25bu,0x59f111f1u,0x923f82a4u,0xab1c5ed5u,
  0xd807aa98u,0x12835b01u,0x243185beu,0x550c7dc3u,0x72be5d74u,0x80deb1feu,0x9bdc06a7u,0xc19bf174u,
  0xe49b69c1u,0xefbe4786u,0x0fc19dc6u,0x240ca1ccu,0x2de92c6fu,0x4a7484aau,0x5cb0a9dcu,0x76f988dau,
  0x983e5152u,0xa831c66du,0xb00327c8u,0xbf597fc7u,0xc6e00bf3u,0xd5a79147u,0x06ca6351u,0x14292967u,
  0x27b70a85u,0x2e1b2138u,0x4d2c6dfcu,0x53380d13u,0x650a7354u,0x766a0abbu,0x81c2c92eu,0x92722c85u,
  0xa2bfe8a1u,0xa81a664bu,0xc24b8b70u,0xc76c51a3u,0xd192e819u,0xd6990624u,0xf40e3585u,0x106aa070u,
  0x19a4c116u,0x1e376c08u,0x2748774cu,0x34b0bcb5u,0x391c0cb3u,0x4ed8aa4au,0x5b9cca4fu,0x682e6ff3u,
  0x748f82eeu,0x78a5636fu,0x84c87814u,0x8cc70208u,0x90befffau,0xa4506cebu,0xbef9a3f7u,0xc67178f2u);

// Each invocation hashes one 64-byte (one-block) message of 'msgLen' bytes.
// Input: packed u32 words (16 per message, big-endian already padded by host).
@group(0) @binding(0) var<storage, read> inp : array<u32>;
@group(0) @binding(1) var<storage, read_write> outp : array<u32>; // 8 words per message

fn rotr(x:u32, n:u32) -> u32 { return (x >> n) | (x << (32u - n)); }

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let idx = gid.x;
  let base = idx * 16u;
  var w : array<u32,64>;
  for (var i=0u; i<16u; i=i+1u) { w[i] = inp[base + i]; }
  for (var i=16u; i<64u; i=i+1u) {
    let s0 = rotr(w[i-15u],7u) ^ rotr(w[i-15u],18u) ^ (w[i-15u] >> 3u);
    let s1 = rotr(w[i-2u],17u) ^ rotr(w[i-2u],19u) ^ (w[i-2u] >> 10u);
    w[i] = w[i-16u] + s0 + w[i-7u] + s1;
  }
  var a=0x6a09e667u; var b=0xbb67ae85u; var c=0x3c6ef372u; var d=0xa54ff53au;
  var e=0x510e527fu; var f=0x9b05688cu; var g=0x1f83d9abu; var h=0x5be0cd19u;
  for (var i=0u; i<64u; i=i+1u) {
    let S1 = rotr(e,6u) ^ rotr(e,11u) ^ rotr(e,25u);
    let ch = (e & f) ^ ((~e) & g);
    let t1 = h + S1 + ch + K[i] + w[i];
    let S0 = rotr(a,2u) ^ rotr(a,13u) ^ rotr(a,22u);
    let maj = (a & b) ^ (a & c) ^ (b & c);
    let t2 = S0 + maj;
    h=g; g=f; f=e; e=d+t1; d=c; c=b; b=a; a=t1+t2;
  }
  let o = idx * 8u;
  outp[o+0u]=0x6a09e667u+a; outp[o+1u]=0xbb67ae85u+b; outp[o+2u]=0x3c6ef372u+c; outp[o+3u]=0xa54ff53au+d;
  outp[o+4u]=0x510e527fu+e; outp[o+5u]=0x9b05688cu+f; outp[o+6u]=0x1f83d9abu+g; outp[o+7u]=0x5be0cd19u+h;
}`;

function padToBlockWords(msg) {
  // single 64-byte block (messages <= 55 bytes), big-endian words
  const block = new Uint8Array(64);
  block.set(msg, 0);
  block[msg.length] = 0x80;
  const bits = msg.length * 8;
  const dv = new DataView(block.buffer);
  dv.setUint32(60, bits >>> 0, false);
  const words = new Uint32Array(16);
  for (let i = 0; i < 16; i++) words[i] = dv.getUint32(i * 4, false);
  return words;
}

export class WebGPUSha256 {
  constructor() { this.device = null; this.pipeline = null; this.ok = false; }

  async init() {
    if (!("gpu" in navigator)) return { ok: false, reason: "WebGPU not available" };
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { ok: false, reason: "no GPU adapter" };
    this.device = await adapter.requestDevice();
    const module = this.device.createShaderModule({ code: SHA256_WGSL });
    this.pipeline = this.device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
    const selfTest = await this.selfTest();
    this.ok = selfTest.ok;
    return selfTest;
  }

  async hashBatch(messages) {
    const n = messages.length;
    const inWords = new Uint32Array(n * 16);
    for (let i = 0; i < n; i++) inWords.set(padToBlockWords(messages[i]), i * 16);
    const inBuf = this.device.createBuffer({ size: inWords.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(inBuf, 0, inWords);
    const outBuf = this.device.createBuffer({ size: n * 8 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readBuf = this.device.createBuffer({ size: n * 8 * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const bind = this.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: inBuf } }, { binding: 1, resource: { buffer: outBuf } }] });
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipeline); pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(Math.ceil(n / 64));
    pass.end();
    enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, n * 8 * 4);
    this.device.queue.submit([enc.finish()]);
    await readBuf.mapAsync(GPUMapMode.READ);
    const words = new Uint32Array(readBuf.getMappedRange().slice(0));
    readBuf.unmap();
    const out = [];
    for (let i = 0; i < n; i++) {
      const bytes = new Uint8Array(32);
      const dv = new DataView(bytes.buffer);
      for (let j = 0; j < 8; j++) dv.setUint32(j * 4, words[i * 8 + j], false);
      out.push(bytes);
    }
    return out;
  }

  // Known-answer gate: GPU must reproduce standard SHA-256 vectors or we refuse.
  async selfTest() {
    const enc = new TextEncoder();
    const cases = [
      ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
      ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ];
    try {
      const hashes = await this.hashBatch(cases.map((c) => enc.encode(c[0])));
      const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
      for (let i = 0; i < cases.length; i++) if (hex(hashes[i]) !== cases[i][1]) return { ok: false, reason: "GPU SHA-256 mismatch (falling back to CPU)" };
      return { ok: true, reason: "GPU SHA-256 self-test passed" };
    } catch (e) { return { ok: false, reason: "GPU self-test error: " + e.message }; }
  }
}
