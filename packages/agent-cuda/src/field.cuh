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
// Optional hand-written PTX 8x8->16 multiply (product scanning, carry-chain
// idiom). Opt-in with -DUSE_PTX_MUL. The schedule is host-verified bit-for-bit
// against the schoolbook reference; the GPU self-test still gates every run,
// so a bad build fails validation instead of searching on wrong math. Build
// WITHOUT the flag to fall back to the proven C multiply at any time.
#ifdef USE_PTX_MUL
// AUTO-GENERATED PTX product-scanning 8x8->16 multiply.
__device__ __forceinline__ void mul16_ptx(uint32_t r[16], const uint32_t a[8], const uint32_t b[8]){
  asm volatile(
    "{\n\t"
    ".reg .u32 c0,c1,c2;\n\t"
    "mov.u32 c0,0;\n\t"
    "mov.u32 c1,0;\n\t"
    "mov.u32 c2,0;\n\t"
    "mad.lo.cc.u32 c0,%16,%24,c0;\n\t"
    "madc.hi.cc.u32 c1,%16,%24,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mov.u32 %0,c0;\n\t"
    "mov.u32 c0,c1;\n\t"
    "mov.u32 c1,c2;\n\t"
    "mov.u32 c2,0;\n\t"
    "mad.lo.cc.u32 c0,%16,%25,c0;\n\t"
    "madc.hi.cc.u32 c1,%16,%25,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%17,%24,c0;\n\t"
    "madc.hi.cc.u32 c1,%17,%24,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mov.u32 %1,c0;\n\t"
    "mov.u32 c0,c1;\n\t"
    "mov.u32 c1,c2;\n\t"
    "mov.u32 c2,0;\n\t"
    "mad.lo.cc.u32 c0,%16,%26,c0;\n\t"
    "madc.hi.cc.u32 c1,%16,%26,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%17,%25,c0;\n\t"
    "madc.hi.cc.u32 c1,%17,%25,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%18,%24,c0;\n\t"
    "madc.hi.cc.u32 c1,%18,%24,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mov.u32 %2,c0;\n\t"
    "mov.u32 c0,c1;\n\t"
    "mov.u32 c1,c2;\n\t"
    "mov.u32 c2,0;\n\t"
    "mad.lo.cc.u32 c0,%16,%27,c0;\n\t"
    "madc.hi.cc.u32 c1,%16,%27,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%17,%26,c0;\n\t"
    "madc.hi.cc.u32 c1,%17,%26,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%18,%25,c0;\n\t"
    "madc.hi.cc.u32 c1,%18,%25,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%19,%24,c0;\n\t"
    "madc.hi.cc.u32 c1,%19,%24,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mov.u32 %3,c0;\n\t"
    "mov.u32 c0,c1;\n\t"
    "mov.u32 c1,c2;\n\t"
    "mov.u32 c2,0;\n\t"
    "mad.lo.cc.u32 c0,%16,%28,c0;\n\t"
    "madc.hi.cc.u32 c1,%16,%28,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%17,%27,c0;\n\t"
    "madc.hi.cc.u32 c1,%17,%27,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%18,%26,c0;\n\t"
    "madc.hi.cc.u32 c1,%18,%26,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%19,%25,c0;\n\t"
    "madc.hi.cc.u32 c1,%19,%25,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%20,%24,c0;\n\t"
    "madc.hi.cc.u32 c1,%20,%24,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mov.u32 %4,c0;\n\t"
    "mov.u32 c0,c1;\n\t"
    "mov.u32 c1,c2;\n\t"
    "mov.u32 c2,0;\n\t"
    "mad.lo.cc.u32 c0,%16,%29,c0;\n\t"
    "madc.hi.cc.u32 c1,%16,%29,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%17,%28,c0;\n\t"
    "madc.hi.cc.u32 c1,%17,%28,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%18,%27,c0;\n\t"
    "madc.hi.cc.u32 c1,%18,%27,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%19,%26,c0;\n\t"
    "madc.hi.cc.u32 c1,%19,%26,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%20,%25,c0;\n\t"
    "madc.hi.cc.u32 c1,%20,%25,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%21,%24,c0;\n\t"
    "madc.hi.cc.u32 c1,%21,%24,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mov.u32 %5,c0;\n\t"
    "mov.u32 c0,c1;\n\t"
    "mov.u32 c1,c2;\n\t"
    "mov.u32 c2,0;\n\t"
    "mad.lo.cc.u32 c0,%16,%30,c0;\n\t"
    "madc.hi.cc.u32 c1,%16,%30,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%17,%29,c0;\n\t"
    "madc.hi.cc.u32 c1,%17,%29,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%18,%28,c0;\n\t"
    "madc.hi.cc.u32 c1,%18,%28,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%19,%27,c0;\n\t"
    "madc.hi.cc.u32 c1,%19,%27,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%20,%26,c0;\n\t"
    "madc.hi.cc.u32 c1,%20,%26,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%21,%25,c0;\n\t"
    "madc.hi.cc.u32 c1,%21,%25,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%22,%24,c0;\n\t"
    "madc.hi.cc.u32 c1,%22,%24,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mov.u32 %6,c0;\n\t"
    "mov.u32 c0,c1;\n\t"
    "mov.u32 c1,c2;\n\t"
    "mov.u32 c2,0;\n\t"
    "mad.lo.cc.u32 c0,%16,%31,c0;\n\t"
    "madc.hi.cc.u32 c1,%16,%31,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%17,%30,c0;\n\t"
    "madc.hi.cc.u32 c1,%17,%30,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%18,%29,c0;\n\t"
    "madc.hi.cc.u32 c1,%18,%29,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%19,%28,c0;\n\t"
    "madc.hi.cc.u32 c1,%19,%28,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%20,%27,c0;\n\t"
    "madc.hi.cc.u32 c1,%20,%27,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%21,%26,c0;\n\t"
    "madc.hi.cc.u32 c1,%21,%26,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%22,%25,c0;\n\t"
    "madc.hi.cc.u32 c1,%22,%25,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%23,%24,c0;\n\t"
    "madc.hi.cc.u32 c1,%23,%24,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mov.u32 %7,c0;\n\t"
    "mov.u32 c0,c1;\n\t"
    "mov.u32 c1,c2;\n\t"
    "mov.u32 c2,0;\n\t"
    "mad.lo.cc.u32 c0,%17,%31,c0;\n\t"
    "madc.hi.cc.u32 c1,%17,%31,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%18,%30,c0;\n\t"
    "madc.hi.cc.u32 c1,%18,%30,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%19,%29,c0;\n\t"
    "madc.hi.cc.u32 c1,%19,%29,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%20,%28,c0;\n\t"
    "madc.hi.cc.u32 c1,%20,%28,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%21,%27,c0;\n\t"
    "madc.hi.cc.u32 c1,%21,%27,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%22,%26,c0;\n\t"
    "madc.hi.cc.u32 c1,%22,%26,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%23,%25,c0;\n\t"
    "madc.hi.cc.u32 c1,%23,%25,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mov.u32 %8,c0;\n\t"
    "mov.u32 c0,c1;\n\t"
    "mov.u32 c1,c2;\n\t"
    "mov.u32 c2,0;\n\t"
    "mad.lo.cc.u32 c0,%18,%31,c0;\n\t"
    "madc.hi.cc.u32 c1,%18,%31,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%19,%30,c0;\n\t"
    "madc.hi.cc.u32 c1,%19,%30,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%20,%29,c0;\n\t"
    "madc.hi.cc.u32 c1,%20,%29,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%21,%28,c0;\n\t"
    "madc.hi.cc.u32 c1,%21,%28,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%22,%27,c0;\n\t"
    "madc.hi.cc.u32 c1,%22,%27,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%23,%26,c0;\n\t"
    "madc.hi.cc.u32 c1,%23,%26,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mov.u32 %9,c0;\n\t"
    "mov.u32 c0,c1;\n\t"
    "mov.u32 c1,c2;\n\t"
    "mov.u32 c2,0;\n\t"
    "mad.lo.cc.u32 c0,%19,%31,c0;\n\t"
    "madc.hi.cc.u32 c1,%19,%31,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%20,%30,c0;\n\t"
    "madc.hi.cc.u32 c1,%20,%30,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%21,%29,c0;\n\t"
    "madc.hi.cc.u32 c1,%21,%29,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%22,%28,c0;\n\t"
    "madc.hi.cc.u32 c1,%22,%28,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%23,%27,c0;\n\t"
    "madc.hi.cc.u32 c1,%23,%27,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mov.u32 %10,c0;\n\t"
    "mov.u32 c0,c1;\n\t"
    "mov.u32 c1,c2;\n\t"
    "mov.u32 c2,0;\n\t"
    "mad.lo.cc.u32 c0,%20,%31,c0;\n\t"
    "madc.hi.cc.u32 c1,%20,%31,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%21,%30,c0;\n\t"
    "madc.hi.cc.u32 c1,%21,%30,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%22,%29,c0;\n\t"
    "madc.hi.cc.u32 c1,%22,%29,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%23,%28,c0;\n\t"
    "madc.hi.cc.u32 c1,%23,%28,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mov.u32 %11,c0;\n\t"
    "mov.u32 c0,c1;\n\t"
    "mov.u32 c1,c2;\n\t"
    "mov.u32 c2,0;\n\t"
    "mad.lo.cc.u32 c0,%21,%31,c0;\n\t"
    "madc.hi.cc.u32 c1,%21,%31,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%22,%30,c0;\n\t"
    "madc.hi.cc.u32 c1,%22,%30,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%23,%29,c0;\n\t"
    "madc.hi.cc.u32 c1,%23,%29,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mov.u32 %12,c0;\n\t"
    "mov.u32 c0,c1;\n\t"
    "mov.u32 c1,c2;\n\t"
    "mov.u32 c2,0;\n\t"
    "mad.lo.cc.u32 c0,%22,%31,c0;\n\t"
    "madc.hi.cc.u32 c1,%22,%31,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mad.lo.cc.u32 c0,%23,%30,c0;\n\t"
    "madc.hi.cc.u32 c1,%23,%30,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mov.u32 %13,c0;\n\t"
    "mov.u32 c0,c1;\n\t"
    "mov.u32 c1,c2;\n\t"
    "mov.u32 c2,0;\n\t"
    "mad.lo.cc.u32 c0,%23,%31,c0;\n\t"
    "madc.hi.cc.u32 c1,%23,%31,c1;\n\t"
    "addc.u32 c2,c2,0;\n\t"
    "mov.u32 %14,c0;\n\t"
    "mov.u32 c0,c1;\n\t"
    "mov.u32 c1,c2;\n\t"
    "mov.u32 c2,0;\n\t"
    "mov.u32 %15,c0;\n\t"
    "}\n\t"
    : "=&r"(r[0]), "=&r"(r[1]), "=&r"(r[2]), "=&r"(r[3]), "=&r"(r[4]), "=&r"(r[5]), "=&r"(r[6]), "=&r"(r[7]), "=&r"(r[8]), "=&r"(r[9]), "=&r"(r[10]), "=&r"(r[11]), "=&r"(r[12]), "=&r"(r[13]), "=&r"(r[14]), "=&r"(r[15])
    : "r"(a[0]), "r"(a[1]), "r"(a[2]), "r"(a[3]), "r"(a[4]), "r"(a[5]), "r"(a[6]), "r"(a[7]), "r"(b[0]), "r"(b[1]), "r"(b[2]), "r"(b[3]), "r"(b[4]), "r"(b[5]), "r"(b[6]), "r"(b[7]));
}
#endif

// Reduce a 16-limb value t modulo p (secp256k1 fast reduction: 2^256 ≡ 2^32+977).
// Shared by mod_mul and the dedicated squaring. t is consumed (modified) in place.
__device__ void reduce16(uint32_t* r, uint32_t* t) {
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
  uint32_t tmp[8];
  while (ge_p(r)) { sub_raw(tmp, r, SECP_P); for (int i = 0; i < 8; ++i) r[i] = tmp[i]; }
}

__device__ void mod_mul(uint32_t* r, const uint32_t* a, const uint32_t* b) {
  uint32_t t[16];
#ifdef USE_PTX_MUL
  mul16_ptx(t, a, b);
#else
  for (int i = 0; i < 16; ++i) t[i] = 0;
  for (int i = 0; i < 8; ++i) {
    uint64_t carry = 0;
    for (int j = 0; j < 8; ++j) {
      uint64_t cur = (uint64_t)t[i + j] + (uint64_t)a[i] * b[j] + carry;
      t[i + j] = (uint32_t)cur; carry = cur >> 32;
    }
    t[i + 8] += (uint32_t)carry;
  }
#endif
  reduce16(r, t);
}

#ifdef USE_SQR
// Dedicated squaring: upper-triangle products (each once), doubled, plus the
// diagonal squares — 36 word-products vs 64 for a general multiply. Host-verified
// bit-for-bit == mul(a,a) over 500k random + edges. Opt-in with -DUSE_SQR.
__device__ __forceinline__ void sqr16(uint32_t* t, const uint32_t* a) {
  for (int i = 0; i < 16; ++i) t[i] = 0;
  for (int i = 0; i < 8; ++i) {              // off-diagonal, each product once
    uint32_t carry = 0;
    for (int j = i + 1; j < 8; ++j) {
      uint64_t p = (uint64_t)a[i] * a[j] + t[i + j] + carry;
      t[i + j] = (uint32_t)p; carry = (uint32_t)(p >> 32);
    }
    t[i + 8] += carry;
  }
  uint32_t c = 0;                            // double the whole 16-limb value
  for (int i = 0; i < 16; ++i) { uint32_t nc = t[i] >> 31; t[i] = (t[i] << 1) | c; c = nc; }
  uint32_t carry = 0;                        // add the diagonal a[i]^2 at 2i
  for (int i = 0; i < 8; ++i) {
    uint64_t sq = (uint64_t)a[i] * a[i];
    uint64_t lo = (uint64_t)t[2*i] + (uint32_t)sq + carry; t[2*i] = (uint32_t)lo;
    uint64_t hi = (uint64_t)t[2*i+1] + (uint32_t)(sq >> 32) + (uint32_t)(lo >> 32); t[2*i+1] = (uint32_t)hi;
    carry = (uint32_t)(hi >> 32);
  }
}
#endif

__device__ void mod_add(uint32_t* r, const uint32_t* a, const uint32_t* b) {
  uint32_t c = add_raw(r, a, b);
  uint32_t tmp[8];
  if (c || ge_p(r)) { sub_raw(tmp, r, SECP_P); for (int i = 0; i < 8; ++i) r[i] = tmp[i]; }
}
__device__ void mod_sub(uint32_t* r, const uint32_t* a, const uint32_t* b) {
  uint32_t borrow = sub_raw(r, a, b);
  if (borrow) { uint32_t tmp[8]; add_raw(tmp, r, SECP_P); for (int i = 0; i < 8; ++i) r[i] = tmp[i]; }
}

__device__ void mod_sqr(uint32_t* r, const uint32_t* a) {
#ifdef USE_SQR
  uint32_t t[16]; sqr16(t, a); reduce16(r, t);
#else
  mod_mul(r, a, a);
#endif
}

// Modular inverse via Fermat: a^(p-2) mod p. p-2 constant below.
__device__ __constant__ uint32_t SECP_P_MINUS_2[8] = {
  0xFFFFFC2D, 0xFFFFFFFE, 0xFFFFFFFF, 0xFFFFFFFF,
  0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF
};
__device__ __forceinline__ void fe_cp(uint32_t* d, const uint32_t* s) { for (int i = 0; i < 8; ++i) d[i] = s[i]; }

// Modular inverse via Fermat with the secp256k1 addition chain (libsecp256k1
// layout): ~255 squarings + 15 multiplications, versus the naive binary
// exponentiation's ~255 squarings + ~249 multiplications. mod_sqr/mod_mul are
// safe in place (operands are read into a local product before the result is
// written), so every step squares/multiplies its own buffer. Verified on host
// bit-for-bit against the binary-exponentiation reference.
__device__ void mod_inv(uint32_t* r, const uint32_t* a) {
  uint32_t x2[8],x3[8],x6[8],x9[8],x11[8],x22[8],x44[8],x88[8],x176[8],x220[8],x223[8],t1[8];
  mod_sqr(x2, a);    mod_mul(x2, x2, a);                              // a^(2^2-1)
  mod_sqr(x3, x2);   mod_mul(x3, x3, a);                              // a^(2^3-1)
  fe_cp(x6, x3);     for (int j=0;j<3;++j) mod_sqr(x6,x6);   mod_mul(x6,x6,x3);     // 2^6-1
  fe_cp(x9, x6);     for (int j=0;j<3;++j) mod_sqr(x9,x9);   mod_mul(x9,x9,x3);     // 2^9-1
  fe_cp(x11, x9);    for (int j=0;j<2;++j) mod_sqr(x11,x11); mod_mul(x11,x11,x2);   // 2^11-1
  fe_cp(x22, x11);   for (int j=0;j<11;++j) mod_sqr(x22,x22); mod_mul(x22,x22,x11); // 2^22-1
  fe_cp(x44, x22);   for (int j=0;j<22;++j) mod_sqr(x44,x44); mod_mul(x44,x44,x22); // 2^44-1
  fe_cp(x88, x44);   for (int j=0;j<44;++j) mod_sqr(x88,x88); mod_mul(x88,x88,x44); // 2^88-1
  fe_cp(x176, x88);  for (int j=0;j<88;++j) mod_sqr(x176,x176); mod_mul(x176,x176,x88); // 2^176-1
  fe_cp(x220, x176); for (int j=0;j<44;++j) mod_sqr(x220,x220); mod_mul(x220,x220,x44); // 2^220-1
  fe_cp(x223, x220); for (int j=0;j<3;++j) mod_sqr(x223,x223); mod_mul(x223,x223,x3);   // 2^223-1
  fe_cp(t1, x223);   for (int j=0;j<23;++j) mod_sqr(t1,t1);  mod_mul(t1,t1,x22);
                     for (int j=0;j<5;++j)  mod_sqr(t1,t1);  mod_mul(t1,t1,a);
                     for (int j=0;j<3;++j)  mod_sqr(t1,t1);  mod_mul(t1,t1,x2);
                     for (int j=0;j<2;++j)  mod_sqr(t1,t1);  mod_mul(r,t1,a);
}
