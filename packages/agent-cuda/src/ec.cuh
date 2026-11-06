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

// key*G -> affine (x,y). key is 8 little-endian limbs. Binary double-and-add:
// clear and proven; used to BUILD the fixed-base comb table below, and kept as
// the trusted reference the host self-test compares against.
__device__ void scalar_mul_G_slow(const uint32_t* key, uint32_t* x, uint32_t* y){
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

// ---- fixed-base comb (windowed) scalar multiply ----
// G is constant, so precompute, for every 4-bit window w (0..63) and nonzero
// digit d (1..15), the affine point (d << 4w) * G. Then key*G = sum over windows
// of the table entry for that window's digit — ~60 point additions and ONE
// inversion, versus 256 doublings + ~128 additions in the binary method. The
// table is built once on the GPU with scalar_mul_G_slow (proven), so the fast
// path adds no new field/EC math — only table lookups and the proven jadd.
__device__ uint32_t d_comb[64][16][16];  // [window][digit][ x0..7, y0..7 ] — 64 KB

__global__ void k_build_comb(){
  int t = blockIdx.x * blockDim.x + threadIdx.x;   // t = win*16 + d
  int win = t >> 4, d = t & 15;
  if(win >= 64 || d == 0) return;                  // d==0 is the identity, never stored
  uint32_t key[8] = {0,0,0,0,0,0,0,0};
  int bitpos = 4*win; uint64_t v = (uint64_t)d << (bitpos & 31); int limb = bitpos >> 5;
  key[limb] |= (uint32_t)v; if(limb+1 < 8) key[limb+1] |= (uint32_t)(v >> 32);
  uint32_t x[8], y[8]; scalar_mul_G_slow(key, x, y);
  for(int i=0;i<8;++i){ d_comb[win][d][i] = x[i]; d_comb[win][d][8+i] = y[i]; }
}

// key*G -> affine (x,y) via the comb table. Requires k_build_comb to have run.
__device__ void scalar_mul_G(const uint32_t* key, uint32_t* x, uint32_t* y){
  jpoint acc; set_u(acc.X,1); set_u(acc.Y,1); set_u(acc.Z,0);
  for(int win=0; win<64; ++win){
    uint32_t d = (key[win>>3] >> ((4*win)&31)) & 0xF;
    if(d){ jpoint P; cp(P.X, &d_comb[win][d][0]); cp(P.Y, &d_comb[win][d][8]); set_u(P.Z,1);
           jpoint t; jadd(t, acc, P); acc = t; }
  }
  uint32_t zi[8],zi2[8],zi3[8];
  mod_inv(zi,acc.Z); mod_sqr(zi2,zi); mod_mul(zi3,zi2,zi);
  mod_mul(x,acc.X,zi2); mod_mul(y,acc.Y,zi3);
}

// compressed pubkey (33 bytes, big-endian x with parity prefix)
__device__ void compressed_pub(const uint32_t* x, const uint32_t* y, uint8_t out[33]){
  out[0] = (y[0]&1u) ? 0x03 : 0x02;
  for(int i=0;i<8;++i){ uint32_t limb=x[7-i]; out[1+i*4]=limb>>24; out[2+i*4]=limb>>16; out[3+i*4]=limb>>8; out[4+i*4]=limb; }
}
