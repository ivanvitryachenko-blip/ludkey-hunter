// RIPEMD-160 for CUDA — mirrors the tested TypeScript reference.
#pragma once
#include <cstdint>

__device__ __constant__ int RL[80] = {0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,7,4,13,1,10,6,15,3,12,0,9,5,2,14,11,8,3,10,14,4,9,15,8,1,2,7,0,6,13,11,5,12,1,9,11,10,0,8,12,4,13,3,7,15,14,5,6,2,4,0,5,9,7,12,2,10,14,1,3,8,11,6,15,13};
__device__ __constant__ int RR[80] = {5,14,7,0,9,2,11,4,13,6,15,8,1,10,3,12,6,11,3,7,0,13,5,10,14,15,8,12,4,9,1,2,15,5,1,3,7,14,6,9,11,8,12,2,10,0,4,13,8,6,4,1,3,11,15,0,5,12,2,13,9,7,10,14,12,15,10,4,1,5,8,7,6,2,13,14,0,3,9,11};
__device__ __constant__ int SLc[80] = {11,14,15,12,5,8,7,9,11,13,14,15,6,7,9,8,7,6,8,13,11,9,7,15,7,12,15,9,11,7,13,12,11,13,6,7,14,9,13,15,14,8,13,6,5,12,7,5,11,12,14,15,14,15,9,8,9,14,5,6,8,6,5,12,9,15,5,11,6,8,13,12,5,12,13,14,11,8,5,6};
__device__ __constant__ int SRc[80] = {8,9,9,11,13,15,15,5,7,7,8,11,14,14,12,6,9,13,15,7,12,8,9,11,7,7,12,7,6,15,13,11,9,7,15,11,8,6,6,14,12,13,5,14,13,13,7,5,15,5,8,11,14,14,6,14,6,9,12,9,12,5,15,8,8,5,12,9,12,5,14,6,8,13,6,5,15,13,11,11};
__device__ __constant__ uint32_t KLc[5] = {0x00000000,0x5a827999,0x6ed9eba1,0x8f1bbcdc,0xa953fd4e};
__device__ __constant__ uint32_t KRc[5] = {0x50a28be6,0x5c4dd124,0x6d703ef3,0x7a6d76e9,0x00000000};

__device__ __forceinline__ uint32_t rol32(uint32_t x,int n){ return (x<<n)|(x>>(32-n)); }
__device__ __forceinline__ uint32_t rf(int j,uint32_t x,uint32_t y,uint32_t z){
  if(j<16) return x^y^z; if(j<32) return (x&y)|(~x&z); if(j<48) return (x|~y)^z; if(j<64) return (x&z)|(y&~z); return x^(y|~z);
}

// Hash exactly 32 bytes (sha256 output) -> 20-byte hash160 stage.
__device__ void ripemd160(const uint8_t* msg, int len, uint8_t out[20]) {
  uint8_t block[64]; for (int i=0;i<64;++i) block[i]=0;
  for (int i=0;i<len;++i) block[i]=msg[i];
  block[len]=0x80;
  uint64_t bits=(uint64_t)len*8;
  for (int i=0;i<8;++i) block[56+i]=(uint8_t)(bits>>(8*i)); // little-endian length (len<=55)
  uint32_t X[16];
  for (int i=0;i<16;++i){ int j=i*4; X[i]=block[j]|(block[j+1]<<8)|(block[j+2]<<16)|(block[j+3]<<24); }

  uint32_t h0=0x67452301,h1=0xefcdab89,h2=0x98badcfe,h3=0x10325476,h4=0xc3d2e1f0;
  uint32_t al=h0,bl=h1,cl=h2,dl=h3,el=h4, ar=h0,br=h1,cr=h2,dr=h3,er=h4;
  for (int j=0;j<80;++j){
    int rnd=j/16;
    uint32_t t=al+rf(j,bl,cl,dl)+X[RL[j]]+KLc[rnd]; t=rol32(t,SLc[j])+el; al=el; el=dl; dl=rol32(cl,10); cl=bl; bl=t;
    int jr=79-j;
    uint32_t tr=ar+rf(jr,br,cr,dr)+X[RR[j]]+KRc[rnd]; tr=rol32(tr,SRc[j])+er; ar=er; er=dr; dr=rol32(cr,10); cr=br; br=tr;
  }
  uint32_t t=h1+cl+dr; h1=h2+dl+er; h2=h3+el+ar; h3=h4+al+br; h4=h0+bl+cr; h0=t;
  uint32_t hs[5]={h0,h1,h2,h3,h4};
  for (int i=0;i<5;++i){ out[i*4]=hs[i]; out[i*4+1]=hs[i]>>8; out[i*4+2]=hs[i]>>16; out[i*4+3]=hs[i]>>24; }
}
