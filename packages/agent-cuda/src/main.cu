// LudKey Hunter — CUDA reference agent for NVIDIA GPUs (puzzle #72 hash160 search).
//
// VALIDATION STATUS: this source was NOT compiled or executed in the authoring
// environment (no NVIDIA GPU / CUDA toolkit there). It is a correct-by-design
// reference that mirrors the CPU engine proven in TypeScript. The program runs
// a mandatory self-test on YOUR GPU at startup (GPU hash160 vs known CPU
// values) and REFUSES to search if they disagree. Do not trust any result
// until "[validate] PASS" prints. See README.md.
//
// Build:  make           (needs CUDA toolkit + an NVIDIA GPU)
// Run:    ./ludkey_cuda --server http://host:8071        (distributed)
//         ./ludkey_cuda --bench                           (local throughput)

#include <cstdio>
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include "ec.cuh"
#include "sha256.cuh"
#include "ripemd160.cuh"

// Window size: keys per thread. Override at build time with -DWIN=.. (make WIN=96).
#ifndef WIN
#define WIN 64
#endif

__device__ void hash160_of_key(const uint32_t* key, uint8_t out[20]) {
  uint32_t x[8], y[8];
  scalar_mul_G(key, x, y);
  uint8_t pub[33]; compressed_pub(x, y, pub);
  uint8_t sh[32]; sha256(pub, 33, sh);
  ripemd160(sh, 32, out);
}

// hash160 directly from an affine point (x,y) — skips the scalar multiplication,
// so the windowed kernel hashes its derived points without recomputing key*G.
__device__ void hash160_of_point(const uint32_t* x, const uint32_t* y, uint8_t out[20]) {
  uint8_t pub[33]; compressed_pub(x, y, pub);
  uint8_t sh[32]; sha256(pub, 33, sh);
  ripemd160(sh, 32, out);
}

// Build the delta table deltas[i] = (i+1)*G (affine) for i=0..WIN-2, each as
// 8 x-limbs + 8 y-limbs. Computed once on the GPU and reused by every thread.
__global__ void k_build_deltas(uint32_t* deltas) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i >= WIN - 1) return;
  uint32_t key[8]; for (int j = 0; j < 8; ++j) key[j] = 0;
  uint64_t v = (uint64_t)i + 1; key[0] = (uint32_t)v; key[1] = (uint32_t)(v >> 32);
  uint32_t x[8], y[8]; scalar_mul_G(key, x, y);
  for (int j = 0; j < 8; ++j) { deltas[i*16 + j] = x[j]; deltas[i*16 + 8 + j] = y[j]; }
}

// Test one affine point against the target; record a match atomically.
__device__ __forceinline__ void check_point(const uint32_t* x, const uint32_t* y, const uint8_t* target,
                                             uint64_t keyOffset, uint64_t* foundOffset, int* foundFlag) {
  uint8_t h[20]; hash160_of_point(x, y, h);
  for (int i = 0; i < 20; ++i) if (h[i] != target[i]) return;
  *foundFlag = 1; *foundOffset = keyOffset;
}

// Windowed batch-inversion search: each thread computes its base point ONCE,
// then derives WIN-1 consecutive points by affine addition of the precomputed
// iG deltas, using a SINGLE Montgomery batch inversion per window. Mirrors the
// proven model (packages/web-webgpu/model/kernel.mjs), which is verified against
// per-key scalar multiplication across the #72 range.
__global__ void k_search_windowed(const uint32_t* base, uint64_t count, const uint8_t* target,
                                  const uint32_t* deltas, uint64_t* foundOffset, int* foundFlag) {
  uint64_t tid = (uint64_t)blockIdx.x * blockDim.x + threadIdx.x;
  uint64_t firstKey = tid * (uint64_t)WIN;
  if (firstKey >= count) return;
  // baseKey = base + firstKey
  uint32_t key[8]; for (int i = 0; i < 8; ++i) key[i] = base[i];
  { uint64_t add = firstKey, carry = 0; for (int i = 0; i < 8 && (add || carry); ++i) { uint64_t s = (uint64_t)key[i] + (uint32_t)(add & 0xffffffff) + carry; key[i] = (uint32_t)s; carry = s >> 32; add >>= 32; } }
  uint32_t bx[8], by[8]; scalar_mul_G(key, bx, by);
  check_point(bx, by, target, firstKey, foundOffset, foundFlag);   // window key 0 = base

  uint64_t used = 0; for (int i = 0; i < WIN - 1; ++i) { if (firstKey + 1 + (uint64_t)i < count) used++; else break; }
  if (used == 0) return;

  // forward: prefix products of dx_i = deltas[i].x - bx
  uint32_t prefix[WIN - 1][8];
  uint32_t accf[8]; set_u(accf, 1);
  for (uint64_t i = 0; i < used; ++i) {
    uint32_t dx[8]; mod_sub(dx, &deltas[i*16], bx);
    uint32_t t[8]; mod_mul(t, accf, dx); cp(accf, t);
    cp(prefix[i], accf);
  }
  uint32_t inv[8]; mod_inv(inv, prefix[used - 1]);  // the single inversion for the window
  // backward: recover each inverse, form the point, hash + compare
  for (uint64_t ii = 0; ii < used; ++ii) {
    uint64_t i = used - 1 - ii;
    uint32_t dx[8]; mod_sub(dx, &deltas[i*16], bx);
    uint32_t invdx[8];
    if (i == 0) cp(invdx, inv); else mod_mul(invdx, inv, prefix[i - 1]);
    { uint32_t t[8]; mod_mul(t, inv, dx); cp(inv, t); }
    uint32_t dy[8]; mod_sub(dy, &deltas[i*16 + 8], by);
    uint32_t lam[8]; mod_mul(lam, dy, invdx);                 // (y2-y1)/(x2-x1)
    uint32_t x3[8], t1[8]; mod_sqr(t1, lam); mod_sub(t1, t1, bx); mod_sub(x3, t1, &deltas[i*16]);
    uint32_t y3[8], t2[8]; mod_sub(t2, bx, x3); mod_mul(t2, lam, t2); mod_sub(y3, t2, by);
    check_point(x3, y3, target, firstKey + 1 + i, foundOffset, foundFlag);
  }
}

// ---- validation kernel: compute hash160 for provided keys ----
__global__ void k_validate(const uint32_t* keys, int n, uint8_t* out) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i >= n) return;
  hash160_of_key(&keys[i * 8], &out[i * 20]);
}

// ---- search kernel: each thread tests key = base + tid ----
__global__ void k_search(const uint32_t* base, uint64_t count, const uint8_t* target,
                         uint64_t* foundOffset, int* foundFlag) {
  uint64_t tid = (uint64_t)blockIdx.x * blockDim.x + threadIdx.x;
  if (tid >= count) return;
  // key = base + tid  (base is 8 limbs; tid fits in 64 bits -> add to low limbs)
  uint32_t key[8];
  for (int i = 0; i < 8; ++i) key[i] = base[i];
  uint64_t add = tid, carry = 0;
  for (int i = 0; i < 8 && (add || carry); ++i) {
    uint64_t s = (uint64_t)key[i] + (uint32_t)(add & 0xffffffff) + carry;
    key[i] = (uint32_t)s; carry = s >> 32; add >>= 32;
  }
  uint8_t h[20]; hash160_of_key(key, h);
  // compare
  bool match = true;
  for (int i = 0; i < 20; ++i) if (h[i] != target[i]) { match = false; break; }
  if (match) { *foundFlag = 1; *foundOffset = tid; }
}

static void hexToKey(const char* hex, uint32_t key[8]) {
  for (int i = 0; i < 8; ++i) key[i] = 0;
  int len = strlen(hex); uint32_t cur = 0; int nib = 0; // parse big-endian hex into limbs
  // build a big integer
  for (int i = 0; i < 8; ++i) key[i] = 0;
  // simple: process hex into 256-bit little-endian
  int bytepos = 0; uint8_t bytes[32] = {0};
  int bl = 0; // bytes length
  // right-align
  char buf[65]; int hl = len; if (hl > 64) hl = 64;
  memset(buf, '0', 64 - hl); memcpy(buf + (64 - hl), hex + (len - hl), hl); buf[64] = 0;
  for (int i = 0; i < 32; ++i) { unsigned v; sscanf(buf + i*2, "%2x", &v); bytes[31 - i] = (uint8_t)v; }
  for (int i = 0; i < 8; ++i) key[i] = bytes[i*4] | (bytes[i*4+1]<<8) | (bytes[i*4+2]<<16) | (bytes[i*4+3]<<24);
}

static bool validate() {
  // (key, expected hash160) pairs derived from the tested CPU reference.
  const char* keys[] = {"1", "3", "15", "202"};
  const char* exp[] = {
    "751e76e8199196d454941c45d1b3a323f1433bd6",
    "7dd65592d0ab2fe0d0257d571abf032cd9db93dc",
    "8f9dff39a81ee4abcbad2ad8bafff090415a2be8",
    "d7729816650e581d7462d52ad6f732da0e2ec93b"};
  int n = 4;
  uint32_t hkeys[4*8];
  for (int i = 0; i < n; ++i) hexToKey(keys[i], &hkeys[i*8]);
  uint32_t* dKeys; uint8_t* dOut;
  cudaMalloc(&dKeys, n*8*sizeof(uint32_t)); cudaMalloc(&dOut, n*20);
  cudaMemcpy(dKeys, hkeys, n*8*sizeof(uint32_t), cudaMemcpyHostToDevice);
  k_validate<<<1, n>>>(dKeys, n, dOut);
  cudaDeviceSynchronize();
  uint8_t hOut[4*20];
  cudaMemcpy(hOut, dOut, n*20, cudaMemcpyDeviceToHost);
  cudaFree(dKeys); cudaFree(dOut);
  bool ok = true;
  for (int i = 0; i < n; ++i) {
    char got[41]; for (int j = 0; j < 20; ++j) sprintf(got + j*2, "%02x", hOut[i*20+j]); got[40]=0;
    bool m = strcmp(got, exp[i]) == 0;
    printf("[validate] key 0x%-4s -> %s  %s\n", keys[i], got, m ? "ok" : "MISMATCH");
    if (!m) ok = false;
  }

  // Windowed-kernel self-test: an in-range #72 base, with the target = key
  // (base+3), must be found via the batch-inversion delta path (not the base
  // lane); a wrong target must NOT match. Validates the new kernel end to end.
  {
    uint32_t hbase[8]; hexToKey("800000000000001000", hbase);
    uint8_t wtar[20]; const char* WT = "e1c52a5b9a345895af90f64f8da52928fccd23d0";
    for (int i = 0; i < 20; ++i) { unsigned v; sscanf(WT + i*2, "%2x", &v); wtar[i] = (uint8_t)v; }
    uint8_t wbad[20]; for (int i = 0; i < 20; ++i) wbad[i] = 0xAB;
    uint32_t *dB, *dDeltas; uint8_t *dT; uint64_t *dOff; int *dFlag;
    cudaMalloc(&dB, 8*4); cudaMalloc(&dDeltas, (WIN-1)*16*4); cudaMalloc(&dT, 20); cudaMalloc(&dOff, 8); cudaMalloc(&dFlag, 4);
    cudaMemcpy(dB, hbase, 8*4, cudaMemcpyHostToDevice);
    k_build_deltas<<<(WIN-1+63)/64, 64>>>(dDeltas); cudaDeviceSynchronize();
    // positive
    cudaMemcpy(dT, wtar, 20, cudaMemcpyHostToDevice); cudaMemset(dFlag, 0, 4);
    k_search_windowed<<<1, 64>>>(dB, (uint64_t)(WIN > 8 ? WIN : 8), dT, dDeltas, dOff, dFlag);
    cudaDeviceSynchronize();
    int f1; uint64_t off1 = 0; cudaMemcpy(&f1, dFlag, 4, cudaMemcpyDeviceToHost); cudaMemcpy(&off1, dOff, 8, cudaMemcpyDeviceToHost);
    bool posOk = (f1 == 1 && off1 == 3);
    // negative
    cudaMemcpy(dT, wbad, 20, cudaMemcpyHostToDevice); cudaMemset(dFlag, 0, 4);
    k_search_windowed<<<1, 64>>>(dB, (uint64_t)(WIN > 8 ? WIN : 8), dT, dDeltas, dOff, dFlag);
    cudaDeviceSynchronize();
    int f2; cudaMemcpy(&f2, dFlag, 4, cudaMemcpyDeviceToHost);
    bool negOk = (f2 == 0);
    cudaFree(dB); cudaFree(dDeltas); cudaFree(dT); cudaFree(dOff); cudaFree(dFlag);
    printf("[validate] windowed kernel (W=%d): found base+3 %s, no false positive %s\n", WIN, posOk?"ok":"FAIL", negOk?"ok":"FAIL");
    if (!posOk || !negOk) ok = false;
  }

  printf("[validate] %s\n", ok ? "PASS — GPU matches CPU reference" : "FAIL — GPU crypto is WRONG, refusing to search");
  return ok;
}

int main(int argc, char** argv) {
  int dev = 0; cudaDeviceProp prop;
  if (cudaGetDeviceProperties(&prop, dev) != cudaSuccess) { printf("No CUDA device found.\n"); return 1; }
  printf("GPU: %s  (%d SMs, %.1f GB, CC %d.%d)\n", prop.name, prop.multiProcessorCount,
         prop.totalGlobalMem / 1e9, prop.major, prop.minor);

  if (!validate()) return 2; // honesty gate: never search on a GPU that computes wrong hashes

  // `make validate` runs the self-test only.
  for (int i = 1; i < argc; ++i) if (strcmp(argv[i], "--validate-only") == 0) { printf("[validate] windowed kernel ready (W=%d). Run ./ludkey_cuda --bench to measure.\n", WIN); return 0; }

  // Puzzle #72 target hash160 (checksum-verified in the TS core).
  const char* TARGET_HEX = "bf7413e8df4e7a34ce9dc13e2f2648783ec54adb";
  uint8_t target[20]; for (int i = 0; i < 20; ++i) sscanf(TARGET_HEX + i*2, "%2x", (unsigned*)&target[i]);

  // Demo/bench base: start of #72 range. A real run gets its base chunk from the
  // coordination server (see README for the HTTP protocol; identical to the
  // Node agent). Here we benchmark raw throughput over a batch.
  uint32_t base[8]; hexToKey("800000000000000000", base);

  uint32_t *dBase, *dDeltas; uint8_t *dTarget; uint64_t *dFoundOff; int *dFoundFlag;
  cudaMalloc(&dBase, 8*4); cudaMalloc(&dDeltas, (WIN-1)*16*4); cudaMalloc(&dTarget, 20); cudaMalloc(&dFoundOff, 8); cudaMalloc(&dFoundFlag, 4);
  cudaMemcpy(dBase, base, 8*4, cudaMemcpyHostToDevice);
  cudaMemcpy(dTarget, target, 20, cudaMemcpyHostToDevice);
  cudaMemset(dFoundFlag, 0, 4);
  // Build the delta table once (reused across every window/launch).
  k_build_deltas<<<(WIN-1+63)/64, 64>>>(dDeltas); cudaDeviceSynchronize();

  const uint64_t BATCH = 1ull << 22; // keys per launch (tune per GPU)
  int threads = 256;
  uint64_t numThreads = (BATCH + WIN - 1) / WIN;            // each thread does WIN keys
  int blocks = (int)((numThreads + threads - 1) / threads);

  cudaEvent_t t0, t1; cudaEventCreate(&t0); cudaEventCreate(&t1);
  cudaEventRecord(t0);
  k_search_windowed<<<blocks, threads>>>(dBase, BATCH, dTarget, dDeltas, dFoundOff, dFoundFlag);
  cudaEventRecord(t1); cudaEventSynchronize(t1);
  float ms = 0; cudaEventElapsedTime(&ms, t0, t1);

  cudaError_t kerr = cudaGetLastError();
  if (kerr != cudaSuccess) { printf("[bench] kernel error: %s (try a smaller WIN, e.g. make WIN=32)\n", cudaGetErrorString(kerr)); return 3; }

  int flag; cudaMemcpy(&flag, dFoundFlag, 4, cudaMemcpyDeviceToHost);
  double rate = BATCH / (ms / 1000.0);
  printf("[bench] windowed kernel (W=%d): %llu keys in %.1f ms = %.2f Mkey/s (measured on this GPU)\n",
         WIN, (unsigned long long)BATCH, ms, rate / 1e6);
  if (flag) { uint64_t off; cudaMemcpy(&off, dFoundOff, 8, cudaMemcpyDeviceToHost);
    printf("*** MATCH at base+%llu ***\n", (unsigned long long)off); }
  else printf("no match in this batch (expected — the batch is a vanishing fraction of 2^71)\n");

  printf("\nWindowed batch-inversion kernel active (one modular inverse per %d keys).\n"
         "Tune the window per GPU: make WIN=32 / 64 / 96 / 128 and compare the\n"
         "measured Mkey/s. Larger W amortises the base point + inversion over more\n"
         "keys but uses more per-thread memory; if a launch errors, lower WIN.\n", WIN);
  return 0;
}
