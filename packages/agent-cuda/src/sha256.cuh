// SHA-256 for CUDA — register-resident single-block variant (input <= 55 bytes).
// Our only inputs are the 33-byte compressed pubkey and its 32-byte SHA digest,
// so one block always suffices. Bit-for-bit identical to the reference; verified
// on host against the original multi-block implementation over random inputs.
#pragma once
#include <cstdint>

__device__ __constant__ uint32_t SHA_K[64] = {
0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};

__device__ __forceinline__ uint32_t rotr32(uint32_t x, int n){ return (x>>n)|(x<<(32-n)); }

// Single-block SHA-256 for len <= 55. Builds the 16 schedule words with
// compile-time indices (so W[] lives in registers) and advances a rolling
// 16-word window during compression instead of a 64-word array.
__device__ void sha256(const uint8_t* msg, int len, uint8_t out[32]) {
  uint32_t W[16];
  #pragma unroll
  for (int i = 0; i < 16; ++i) {
    uint32_t word = 0;
    #pragma unroll
    for (int b = 0; b < 4; ++b) {
      int idx = i*4 + b;                                   // compile-time
      uint8_t v = (idx < len) ? msg[idx] : (idx == len ? 0x80 : 0x00);
      word |= (uint32_t)v << (24 - 8*b);                   // big-endian
    }
    W[i] = word;
  }
  uint64_t bits = (uint64_t)len * 8;                       // len<=55 -> fits bytes 56..63
  W[14] = (uint32_t)(bits >> 32);
  W[15] = (uint32_t)bits;

  uint32_t a=0x6a09e667,b=0xbb67ae85,c=0x3c6ef372,d=0xa54ff53a,
           e=0x510e527f,f=0x9b05688c,g=0x1f83d9ab,h=0x5be0cd19;
  #pragma unroll
  for (int i = 0; i < 64; ++i) {
    if (i >= 16) {
      uint32_t w15 = W[(i+1)&15], w2 = W[(i+14)&15];
      uint32_t s0 = rotr32(w15,7)^rotr32(w15,18)^(w15>>3);
      uint32_t s1 = rotr32(w2,17)^rotr32(w2,19)^(w2>>10);
      W[i&15] += s0 + W[(i+9)&15] + s1;
    }
    uint32_t S1 = rotr32(e,6)^rotr32(e,11)^rotr32(e,25);
    uint32_t ch = (e&f)^((~e)&g);
    uint32_t t1 = h + S1 + ch + SHA_K[i] + W[i&15];
    uint32_t S0 = rotr32(a,2)^rotr32(a,13)^rotr32(a,22);
    uint32_t maj = (a&b)^(a&c)^(b&c);
    uint32_t t2 = S0 + maj;
    h=g; g=f; f=e; e=d+t1; d=c; c=b; b=a; a=t1+t2;
  }
  uint32_t hs[8] = {0x6a09e667+a,0xbb67ae85+b,0x3c6ef372+c,0xa54ff53a+d,
                    0x510e527f+e,0x9b05688c+f,0x1f83d9ab+g,0x5be0cd19+h};
  #pragma unroll
  for (int i=0;i<8;++i){ out[i*4]=hs[i]>>24; out[i*4+1]=hs[i]>>16; out[i*4+2]=hs[i]>>8; out[i*4+3]=hs[i]; }
}
