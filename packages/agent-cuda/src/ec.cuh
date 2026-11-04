// secp256k1 EC point arithmetic (Jacobian) for CUDA — mirrors the tested
// TypeScript reference. Reference kernel: each thread computes key*G from
// scratch (clear and verifiable); the batch-addition optimization used by the
// CPU engine is the documented next step for higher throughput.
#pragma once
#include "field.cuh"

__device__ __constant__ uint32_t GX[8] = {0x16f81798,0x59f2815b,0x2dce28d9,0x029bfcdb,0xce870b07,0x55a06295,0xf9dcbbac,0x79be667e};
__device__ __constant__ uint32_t GY[8] = {0xfb10d4b8,0x9c47d08f,0xa6855419,0xfd17b448,0x0e1108a8,0x5da4fbfc,0x26a3c465,0x483ada77};

struct jpoint { uint32_t X[8], Y[8], Z[8]; };

__device__ __forceinline__ bool is_zero(const uint32_t* a){ for(int i=0;i<8;++i) if(a[i]) return false; return true; }
__device__ __forceinline__ bool eq(const uint32_t* a, const uint32_t* b){ for(int i=0;i<8;++i) if(a[i]!=b[i]) return false; return true; }
__device__ __forceinline__ void cp(uint32_t* d, const uint32_t* s){ for(int i=0;i<8;++i) d[i]=s[i]; }
__device__ __forceinline__ void set_u(uint32_t* d, uint32_t v){ d[0]=v; for(int i=1;i<8;++i) d[i]=0; }

__device__ void jdbl(jpoint& r, const jpoint& p){
  if(is_zero(p.Z) || is_zero((uint32_t*)p.Y)){ set_u(r.X,1); set_u(r.Y,1); set_u(r.Z,0); return; }
  uint32_t A[8],B[8],C[8],D[8],E[8],F[8],t1[8],t2[8];
  mod_sqr(A,p.X); mod_sqr(B,p.Y); mod_sqr(C,B);
  mod_add(t1,p.X,B); mod_sqr(t1,t1); mod_sub(t1,t1,A); mod_sub(t1,t1,C); mod_add(D,t1,t1); // D=2*((X+B)^2 - A - C)
  mod_add(E,A,A); mod_add(E,E,A);     // E=3A
  mod_sqr(F,E);
  mod_add(t1,D,D); mod_sub(r.X,F,t1); // X3 = F - 2D
  mod_sub(t1,D,r.X); mod_mul(t1,E,t1);
  mod_add(t2,C,C); mod_add(t2,t2,t2); mod_add(t2,t2,t2); // 8C
  mod_sub(r.Y,t1,t2);
  mod_mul(t1,p.Y,p.Z); mod_add(r.Z,t1,t1); // Z3=2*Y*Z
}

__device__ void jadd(jpoint& r, const jpoint& p, const jpoint& q){
  if(is_zero(p.Z)){ r=q; return; } if(is_zero(q.Z)){ r=p; return; }
  uint32_t Z1[8],Z2[8],U1[8],U2[8],S1[8],S2[8],H[8],I[8],J[8],rr[8],V[8],t1[8],t2[8];
  mod_sqr(Z1,p.Z); mod_sqr(Z2,q.Z);
  mod_mul(U1,p.X,Z2); mod_mul(U2,q.X,Z1);
  mod_mul(t1,p.Y,q.Z); mod_mul(S1,t1,Z2);
  mod_mul(t1,q.Y,p.Z); mod_mul(S2,t1,Z1);
  if(eq(U1,U2)){ if(!eq(S1,S2)){ set_u(r.X,1); set_u(r.Y,1); set_u(r.Z,0); return; } jdbl(r,p); return; }
  mod_sub(H,U2,U1); mod_add(I,H,H); mod_sqr(I,I); mod_mul(J,H,I);
  mod_sub(rr,S2,S1); mod_add(rr,rr,rr);
  mod_mul(V,U1,I);
  mod_sqr(t1,rr); mod_sub(t1,t1,J); mod_add(t2,V,V); mod_sub(r.X,t1,t2);
  mod_sub(t1,V,r.X); mod_mul(t1,rr,t1); mod_mul(t2,S1,J); mod_add(t2,t2,t2); mod_sub(r.Y,t1,t2);
  mod_add(t1,p.Z,q.Z); mod_sqr(t1,t1); mod_sub(t1,t1,Z1); mod_sub(t1,t1,Z2); mod_mul(r.Z,t1,H);
}

// key*G -> affine (x,y). key is 8 little-endian limbs.
__device__ void scalar_mul_G(const uint32_t* key, uint32_t* x, uint32_t* y){
  jpoint acc; set_u(acc.X,1); set_u(acc.Y,1); set_u(acc.Z,0);
  jpoint add; cp(add.X,GX); cp(add.Y,GY); set_u(add.Z,1);
  for(int bit=0; bit<256; ++bit){
    if((key[bit>>5]>>(bit&31))&1u){ jpoint t; jadd(t,acc,add); acc=t; }
    jpoint t2; jdbl(t2,add); add=t2;
  }
  // to affine
  uint32_t zi[8],zi2[8],zi3[8];
  mod_inv(zi,acc.Z); mod_sqr(zi2,zi); mod_mul(zi3,zi2,zi);
  mod_mul(x,acc.X,zi2); mod_mul(y,acc.Y,zi3);
}

// compressed pubkey (33 bytes, big-endian x with parity prefix)
__device__ void compressed_pub(const uint32_t* x, const uint32_t* y, uint8_t out[33]){
  out[0] = (y[0]&1u) ? 0x03 : 0x02;
  for(int i=0;i<8;++i){ uint32_t limb=x[7-i]; out[1+i*4]=limb>>24; out[2+i*4]=limb>>16; out[3+i*4]=limb>>8; out[4+i*4]=limb; }
}
