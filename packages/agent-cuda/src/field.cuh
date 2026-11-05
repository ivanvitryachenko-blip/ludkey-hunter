// 256-bit unsigned integer + secp256k1 field arithmetic for CUDA.
//
// Limbs are 8 x uint32 little-endian (u[0] is least significant). This mirrors
// the arithmetic proven in the TypeScript reference core; the host-side
// validator (main.cu) re-checks every operation against that reference on the
// actual GPU before any search is trusted. VALIDATION STATUS: not compiled or
// run in the authoring environment (no NVIDIA GPU present); run `make validate`
// on your card first — the program refuses to search if the GPU disagrees with
// the CPU reference.
#pragma once
#include <cstdint>

struct u256 { uint32_t u[8]; };

// p = 2^256 - 2^32 - 977  (0xFFFFFFFF...FFFFFC2F)
__device__ __constant__ uint32_t SECP_P[8] = {
  0xFFFFFC2F, 0xFFFFFFFE, 0xFFFFFFFF, 0xFFFFFFFF,
  0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF
};

__device__ __forceinline__ bool ge_p(const uint32_t* a) {
  for (int i = 7; i >= 0; --i) { if (a[i] != SECP_P[i]) return a[i] > SECP_P[i]; }
  return true; // equal counts as >= p
}

__device__ __forceinline__ uint32_t add_raw(uint32_t* r, const uint32_t* a, const uint32_t* b) {
  uint64_t c = 0;
  for (int i = 0; i < 8; ++i) { uint64_t s = (uint64_t)a[i] + b[i] + c; r[i] = (uint32_t)s; c = s >> 32; }
  return (uint32_t)c;
}
__device__ __forceinline__ uint32_t sub_raw(uint32_t* r, const uint32_t* a, const uint32_t* b) {
  uint64_t borrow = 0;
  for (int i = 0; i < 8; ++i) { uint64_t d = (uint64_t)a[i] - b[i] - borrow; r[i] = (uint32_t)d; borrow = (d >> 63) & 1; }
  return (uint32_t)borrow;
}

// Reduce a 16-limb product modulo p using secp256k1's fast reduction:
// since 2^256 ≡ 2^32 + 977 (mod p), fold the high half back in twice.
__device__ void mod_mul(uint32_t* r, const uint32_t* a, const uint32_t* b) {
  uint32_t t[16] = {0};
  for (int i = 0; i < 8; ++i) {
    uint64_t carry = 0;
    for (int j = 0; j < 8; ++j) {
      uint64_t cur = (uint64_t)t[i + j] + (uint64_t)a[i] * b[j] + carry;
      t[i + j] = (uint32_t)cur; carry = cur >> 32;
    }
    t[i + 8] += (uint32_t)carry;
  }
  // Fold the high limbs (t[8..15]) into the low using 2^256 ≡ 2^32 + 977 (mod p):
  // high*K contributes high*977 at position 0 and high<<32 at position 1. Carries
  // out of the low 8 limbs are propagated back into the high limbs and folded
  // again, repeating until the whole high half is zero (converges in a few passes).
  for (int pass = 0; pass < 8; ++pass) {
    bool anyHigh = false;
    for (int i = 8; i < 16; ++i) if (t[i]) { anyHigh = true; break; }
    if (!anyHigh) break;
    uint32_t hi[8];
    for (int i = 0; i < 8; ++i) { hi[i] = t[i + 8]; t[i + 8] = 0; }
    // low += hi * 977
    uint64_t carry = 0;
    for (int i = 0; i < 8; ++i) {
      uint64_t cur = (uint64_t)t[i] + (uint64_t)hi[i] * 977ULL + carry;
      t[i] = (uint32_t)cur; carry = cur >> 32;
    }
    for (int i = 8; i < 16 && carry; ++i) { uint64_t cur = (uint64_t)t[i] + carry; t[i] = (uint32_t)cur; carry = cur >> 32; }
    // low += hi << 32  (add hi[i] at position i+1)
    uint64_t c2 = 0;
    for (int i = 0; i < 8; ++i) {
      uint64_t cur = (uint64_t)t[i + 1] + hi[i] + c2;
      t[i + 1] = (uint32_t)cur; c2 = cur >> 32;
    }
    for (int i = 9; i < 16 && c2; ++i) { uint64_t cur = (uint64_t)t[i] + c2; t[i] = (uint32_t)cur; c2 = cur >> 32; }
  }
  for (int i = 0; i < 8; ++i) r[i] = t[i];
  // final conditional subtractions
  uint32_t tmp[8];
  while (ge_p(r)) { sub_raw(tmp, r, SECP_P); for (int i = 0; i < 8; ++i) r[i] = tmp[i]; }
}

__device__ void mod_add(uint32_t* r, const uint32_t* a, const uint32_t* b) {
  uint32_t c = add_raw(r, a, b);
  uint32_t tmp[8];
  if (c || ge_p(r)) { sub_raw(tmp, r, SECP_P); for (int i = 0; i < 8; ++i) r[i] = tmp[i]; }
}
__device__ void mod_sub(uint32_t* r, const uint32_t* a, const uint32_t* b) {
  uint32_t borrow = sub_raw(r, a, b);
  if (borrow) { uint32_t tmp[8]; add_raw(tmp, r, SECP_P); for (int i = 0; i < 8; ++i) r[i] = tmp[i]; }
}

__device__ void mod_sqr(uint32_t* r, const uint32_t* a) { mod_mul(r, a, a); }

// Modular inverse via Fermat: a^(p-2) mod p. p-2 constant below.
__device__ __constant__ uint32_t SECP_P_MINUS_2[8] = {
  0xFFFFFC2D, 0xFFFFFFFE, 0xFFFFFFFF, 0xFFFFFFFF,
  0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF
};
__device__ void mod_inv(uint32_t* r, const uint32_t* a) {
  uint32_t result[8] = {1,0,0,0,0,0,0,0};
  uint32_t base[8]; for (int i = 0; i < 8; ++i) base[i] = a[i];
  for (int bit = 0; bit < 256; ++bit) {
    uint32_t limb = SECP_P_MINUS_2[bit >> 5];
    if ((limb >> (bit & 31)) & 1u) { uint32_t t[8]; mod_mul(t, result, base); for (int i=0;i<8;++i) result[i]=t[i]; }
    uint32_t s[8]; mod_sqr(s, base); for (int i=0;i<8;++i) base[i]=s[i];
  }
  for (int i = 0; i < 8; ++i) r[i] = result[i];
}
