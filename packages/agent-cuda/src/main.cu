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
#include <ctime>
#include <random>
#include <unordered_set>
#include "ec.cuh"
#include "sha256.cuh"
#include "ripemd160.cuh"

// Window size: keys per thread. Override at build time with -DWIN=.. (make WIN=96).
#ifndef WIN
#define WIN 896   // tuned for GTX 1650 (sm_75) — measured best; override with -DWIN=
#endif
// Threads per block (override with -DTPB=..; sweep 128/192/256/384/512 per GPU).
#ifndef TPB
#define TPB 128   // tuned for GTX 1650 (sm_75) — measured best; override with -DTPB=
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
// Load 8 consecutive limbs through the read-only data cache (__ldg). The delta
// table is read-only and every thread in a warp reads the SAME deltas[i] at the
// same loop step (lock-step broadcast), so routing these loads through the
// read-only cache is the ideal access pattern.
__device__ __forceinline__ void ldg8(uint32_t* d, const uint32_t* __restrict__ s) {
  #pragma unroll
  for (int j = 0; j < 8; ++j) d[j] = __ldg(&s[j]);
}

__global__ void k_search_windowed(const uint32_t* __restrict__ base, uint64_t count,
                                  const uint8_t* __restrict__ target,
                                  const uint32_t* __restrict__ deltas,
                                  uint64_t* foundOffset, int* foundFlag) {
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
    uint32_t dxv[8]; ldg8(dxv, &deltas[i*16]);            // read-only cached delta.x
    uint32_t dx[8]; mod_sub(dx, dxv, bx);
    uint32_t t[8]; mod_mul(t, accf, dx); cp(accf, t);
    cp(prefix[i], accf);
  }
  uint32_t inv[8]; mod_inv(inv, prefix[used - 1]);  // the single inversion for the window
  // backward: recover each inverse, form the point, hash + compare
  for (uint64_t ii = 0; ii < used; ++ii) {
    uint64_t i = used - 1 - ii;
    uint32_t dxv[8], dyv[8];
    ldg8(dxv, &deltas[i*16]);          // delta.x — one cached load, reused below
    ldg8(dyv, &deltas[i*16 + 8]);      // delta.y
    uint32_t dx[8]; mod_sub(dx, dxv, bx);
    uint32_t invdx[8];
    if (i == 0) cp(invdx, inv); else mod_mul(invdx, inv, prefix[i - 1]);
    { uint32_t t[8]; mod_mul(t, inv, dx); cp(inv, t); }
    uint32_t dy[8]; mod_sub(dy, dyv, by);
    uint32_t lam[8]; mod_mul(lam, dy, invdx);                 // (y2-y1)/(x2-x1)
    uint32_t x3[8], t1[8]; mod_sqr(t1, lam); mod_sub(t1, t1, bx); mod_sub(x3, t1, dxv);
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

// ---- standalone mode: search random 2^25 segments of #72 on the GPU, sharing
// progress with the Go CPU agent so the two run together without overlap ----
#define GPU_PROGRESS "ludkey-progress-gpu.txt"
#define PUZZLE_ADDR  "1JTK7s9YVYywfm5XUH7RNhHJH1LshCaRFR"

// Build the 8x32 limb key for Puzzle #72 = 2^71 + idx*2^25 + sub, using only
// 64-bit math (MSVC/nvcc on Windows has no __int128). idx < 2^46, sub < 2^25.
static void keyFromSeg(uint64_t idx, uint64_t sub, uint32_t key[8]) {
  for (int i = 0; i < 8; ++i) key[i] = 0;
  auto addLimbs = [&](const uint32_t add[8]) {
    uint64_t c = 0;
    for (int i = 0; i < 8; ++i) { uint64_t s = (uint64_t)key[i] + add[i] + c; key[i] = (uint32_t)s; c = s >> 32; }
  };
  { uint32_t a[8] = {0}; a[0] = (uint32_t)sub; a[1] = (uint32_t)(sub >> 32); addLimbs(a); }            // + sub
  { uint64_t lo = idx << 25, hi = idx >> 39;                                                           // idx*2^25 as 128-bit hi:lo
    uint32_t a[8] = { (uint32_t)lo, (uint32_t)(lo >> 32), (uint32_t)hi, (uint32_t)(hi >> 32), 0,0,0,0 }; addLimbs(a); }
  { uint32_t a[8] = {0}; a[2] = 0x80; addLimbs(a); }                                                   // + 2^71 (bit 71)
}
// Big-endian hex of an 8x32 key, leading zeros trimmed.
static void keyHex(const uint32_t key[8], char* out) {
  int top = 7; while (top > 0 && key[top] == 0) --top;
  int p = 0; char first[9]; sprintf(first, "%x", key[top]); for (char* c = first; *c; ++c) out[p++] = *c;
  for (int i = top - 1; i >= 0; --i) { sprintf(out + p, "%08x", key[i]); p += 8; }
  out[p] = 0;
}
static void loadProgress(std::unordered_set<uint64_t>& done, const char* path) {
  FILE* f = fopen(path, "r"); if (!f) return;
  char line[64];
  while (fgets(line, sizeof(line), f)) { if (line[0] >= '0' && line[0] <= '9') done.insert(strtoull(line, nullptr, 10)); }
  fclose(f);
}

static int runStandalone(const uint8_t* targetHost) {
  std::unordered_set<uint64_t> done;
  loadProgress(done, "ludkey-progress.txt");  // the Go CPU agent's file
  loadProgress(done, GPU_PROGRESS);           // our own
  printf("[standalone] loaded %zu done segments; GPU searching random 2^25 segments of #72\n", done.size());
  printf("[standalone] progress file: %s (CPU agent's ludkey-progress.txt is also skipped)\n", GPU_PROGRESS);

  uint32_t *dBase, *dDeltas; uint8_t *dTarget; uint64_t *dFoundOff; int *dFoundFlag;
  cudaMalloc(&dBase, 8*4); cudaMalloc(&dDeltas, (WIN-1)*16*4); cudaMalloc(&dTarget, 20); cudaMalloc(&dFoundOff, 8); cudaMalloc(&dFoundFlag, 4);
  cudaMemcpy(dTarget, targetHost, 20, cudaMemcpyHostToDevice);
  k_build_deltas<<<(WIN-1+63)/64, 64>>>(dDeltas); cudaDeviceSynchronize();

  std::mt19937_64 rng(((uint64_t)time(nullptr)) ^ ((uint64_t)clock() << 21));
  const uint64_t SEG_SIZE = 1ull << 25;
  const uint64_t IDX_MASK = (1ull << 46) - 1;    // 2^71 / 2^25 = 2^46 segments
  const uint64_t BATCH = 1ull << 22; int threads = TPB;
  uint64_t baseDone = done.size(), segThisRun = 0;

  while (true) {
    uint64_t idx; int tries = 0;
    do { idx = rng() & IDX_MASK; } while (done.count(idx) && ++tries < 64);
    done.insert(idx);

    uint64_t scanned = 0; bool found = false; uint64_t foundOff = 0;
    clock_t t0 = clock();
    while (scanned < SEG_SIZE) {
      uint64_t cnt = (SEG_SIZE - scanned < BATCH) ? (SEG_SIZE - scanned) : BATCH;
      uint32_t base[8]; keyFromSeg(idx, scanned, base);
      cudaMemcpy(dBase, base, 8*4, cudaMemcpyHostToDevice); cudaMemset(dFoundFlag, 0, 4);
      uint64_t numThreads = (cnt + WIN - 1) / WIN; int blocks = (int)((numThreads + threads - 1) / threads);
      k_search_windowed<<<blocks, threads>>>(dBase, cnt, dTarget, dDeltas, dFoundOff, dFoundFlag);
      cudaDeviceSynchronize();
      cudaError_t e = cudaGetLastError();
      if (e != cudaSuccess) { printf("\n[standalone] kernel error: %s (try a smaller WIN)\n", cudaGetErrorString(e)); return 3; }
      int flag; cudaMemcpy(&flag, dFoundFlag, 4, cudaMemcpyDeviceToHost);
      if (flag) { uint64_t off; cudaMemcpy(&off, dFoundOff, 8, cudaMemcpyDeviceToHost); found = true; foundOff = scanned + off; break; }
      scanned += cnt;
    }

    if (found) {
      uint32_t fk[8]; keyFromSeg(idx, foundOff, fk);
      char hx[80]; keyHex(fk, hx);
      FILE* ff = fopen("FOUND_KEY.txt", "w");
      if (ff) { fprintf(ff, "when: standalone GPU\nprivate key (hex): 0x%s\naddress: %s\n", hx, PUZZLE_ADDR); fclose(ff); }
      printf("\n\n*** MATCH *** private key = 0x%s\n  saved to FOUND_KEY.txt — import the key and sweep (the Go agent can auto-sweep)\n", hx);
      return 0;
    }
    FILE* pf = fopen(GPU_PROGRESS, "a"); if (pf) { fprintf(pf, "%llu\n", (unsigned long long)idx); fflush(pf); fclose(pf); }
    segThisRun++;
    double secs = (double)(clock() - t0) / CLOCKS_PER_SEC;
    double mkps = secs > 0 ? (SEG_SIZE / secs) / 1e6 : 0;
    printf("\r[standalone] %llu segments done (%llu total) · %.2f Mkey/s · W=%d       ",
           (unsigned long long)segThisRun, (unsigned long long)(baseDone + segThisRun), mkps, WIN);
    fflush(stdout);
  }
}

// Sustained-average benchmark: run the search kernel back-to-back for ~secs
// seconds (after a warm-up) and report total keys / wall time. Removes the
// per-segment and clock-ramp noise of the live standalone readout, for fair A/B.
static int runAvgBench(const uint8_t* targetHost, double secs) {
  uint32_t base[8]; hexToKey("800000000000000000", base);
  uint32_t *dBase, *dDeltas; uint8_t *dTarget; uint64_t *dFoundOff; int *dFoundFlag;
  cudaMalloc(&dBase, 8*4); cudaMalloc(&dDeltas, (WIN-1)*16*4); cudaMalloc(&dTarget, 20); cudaMalloc(&dFoundOff, 8); cudaMalloc(&dFoundFlag, 4);
  cudaMemcpy(dBase, base, 8*4, cudaMemcpyHostToDevice);
  cudaMemcpy(dTarget, targetHost, 20, cudaMemcpyHostToDevice);
  cudaMemset(dFoundFlag, 0, 4);
  k_build_deltas<<<(WIN-1+63)/64, 64>>>(dDeltas); cudaDeviceSynchronize();

  const uint64_t BATCH = 1ull << 22; int threads = TPB;
  uint64_t numThreads = (BATCH + WIN - 1) / WIN; int blocks = (int)((numThreads + threads - 1) / threads);

  // warm-up (excluded from the timing) so the GPU is at boost clock before we measure
  for (int w = 0; w < 5; ++w) k_search_windowed<<<blocks, threads>>>(dBase, BATCH, dTarget, dDeltas, dFoundOff, dFoundFlag);
  cudaDeviceSynchronize();

  printf("[avgbench] warming done; measuring ~%.0f s sustained (W=%d)...\n", secs, WIN);
  cudaEvent_t t0, t1; cudaEventCreate(&t0); cudaEventCreate(&t1);
  cudaEventRecord(t0);
  uint64_t totalKeys = 0; const int BURST = 24;
  while (true) {
    for (int b = 0; b < BURST; ++b) k_search_windowed<<<blocks, threads>>>(dBase, BATCH, dTarget, dDeltas, dFoundOff, dFoundFlag);
    cudaDeviceSynchronize();
    cudaError_t e = cudaGetLastError();
    if (e != cudaSuccess) { printf("[avgbench] kernel error: %s\n", cudaGetErrorString(e)); return 3; }
    totalKeys += (uint64_t)BATCH * BURST;
    cudaEventRecord(t1); cudaEventSynchronize(t1);
    float ms = 0; cudaEventElapsedTime(&ms, t0, t1);
    if (ms / 1000.0 >= secs) {
      double rate = totalKeys / (ms / 1000.0);
      printf("[avgbench] %.1f s, %llu keys = %.2f Mkey/s (sustained average, W=%d, TPB=%d)\n",
             ms / 1000.0, (unsigned long long)totalKeys, rate / 1e6, WIN, TPB);
      break;
    }
  }
  return 0;
}

// out = base + off  (256-bit base, 64-bit offset). Host helper for --serve.
static void addKeyOffset(const uint32_t base[8], uint64_t off, uint32_t out[8]) {
  uint64_t c = 0, s;
  s = (uint64_t)base[0] + (uint32_t)off;        out[0] = (uint32_t)s; c = s >> 32;
  s = (uint64_t)base[1] + (uint32_t)(off>>32) + c; out[1] = (uint32_t)s; c = s >> 32;
  for (int i = 2; i < 8; ++i) { s = (uint64_t)base[i] + c; out[i] = (uint32_t)s; c = s >> 32; }
}

// --serve: GPU worker driven over stdin by the Go agent (which talks to the
// coordinator). Protocol, one request per line: "<startHex> <count>" -> search
// the <count> keys starting at <startHex> on the GPU and reply with a single
// line: "DONE" (no match) or "FOUND <keyHex>" (also written to FOUND_KEY.txt).
// Prints "READY" once the delta table is built. All networking stays in Go.
static int runServe(const uint8_t* targetHost) {
  uint32_t *dBase, *dDeltas; uint8_t *dTarget; uint64_t *dFoundOff; int *dFoundFlag;
  cudaMalloc(&dBase, 8*4); cudaMalloc(&dDeltas, (WIN-1)*16*4); cudaMalloc(&dTarget, 20); cudaMalloc(&dFoundOff, 8); cudaMalloc(&dFoundFlag, 4);
  cudaMemcpy(dTarget, targetHost, 20, cudaMemcpyHostToDevice);
  k_build_deltas<<<(WIN-1+63)/64, 64>>>(dDeltas); cudaDeviceSynchronize();
  const uint64_t BATCH = 1ull << 22; int threads = TPB;
  printf("READY\n"); fflush(stdout);
  char line[256];
  while (fgets(line, sizeof(line), stdin)) {
    char hx[160]; unsigned long long count = 0;
    if (sscanf(line, "%159s %llu", hx, &count) != 2) { printf("ERR parse\n"); fflush(stdout); continue; }
    uint32_t base[8]; hexToKey(hx, base);
    bool found = false; uint64_t foundOff = 0, scanned = 0;
    while (scanned < (uint64_t)count) {
      uint64_t remain = (uint64_t)count - scanned;
      uint64_t cnt = remain < BATCH ? remain : BATCH;
      uint32_t b2[8]; addKeyOffset(base, scanned, b2);
      cudaMemcpy(dBase, b2, 8*4, cudaMemcpyHostToDevice); cudaMemset(dFoundFlag, 0, 4);
      uint64_t numThreads = (cnt + WIN - 1) / WIN; int blocks = (int)((numThreads + threads - 1) / threads);
      k_search_windowed<<<blocks, threads>>>(dBase, cnt, dTarget, dDeltas, dFoundOff, dFoundFlag);
      cudaDeviceSynchronize();
      cudaError_t e = cudaGetLastError();
      if (e != cudaSuccess) { printf("ERR kernel %s\n", cudaGetErrorString(e)); fflush(stdout); found = false; break; }
      int flag; cudaMemcpy(&flag, dFoundFlag, 4, cudaMemcpyDeviceToHost);
      if (flag) { uint64_t off; cudaMemcpy(&off, dFoundOff, 8, cudaMemcpyDeviceToHost); found = true; foundOff = scanned + off; break; }
      scanned += cnt;
    }
    if (found) {
      uint32_t fk[8]; addKeyOffset(base, foundOff, fk); char kh[80]; keyHex(fk, kh);
      FILE* ff = fopen("FOUND_KEY.txt", "w");
      if (ff) { fprintf(ff, "when: GPU serve\nprivate key (hex): 0x%s\naddress: %s\n", kh, PUZZLE_ADDR); fclose(ff); }
      printf("FOUND %s\n", kh); fflush(stdout);
      return 0; // a find ends the process; the Go agent sweeps from FOUND_KEY.txt
    }
    printf("DONE\n"); fflush(stdout);
  }
  return 0;
}

int main(int argc, char** argv) {
  int dev = 0; cudaDeviceProp prop;
  if (cudaGetDeviceProperties(&prop, dev) != cudaSuccess) { printf("No CUDA device found.\n"); return 1; }
  printf("GPU: %s  (%d SMs, %.1f GB, CC %d.%d)\n", prop.name, prop.multiProcessorCount,
         prop.totalGlobalMem / 1e9, prop.major, prop.minor);

  // Build the fixed-base comb table once (uses the proven slow multiply); every
  // scalar_mul_G afterward reads it. Must run before validate(), which tests
  // the comb-based scalar_mul_G through key->hash160.
  k_build_comb<<<64, 16>>>(); cudaDeviceSynchronize();
  { cudaError_t e = cudaGetLastError(); if (e != cudaSuccess) { printf("comb table build error: %s\n", cudaGetErrorString(e)); return 4; } }

  if (!validate()) return 2; // honesty gate: never search on a GPU that computes wrong hashes

  // `make validate` runs the self-test only.
  for (int i = 1; i < argc; ++i) if (strcmp(argv[i], "--validate-only") == 0) { printf("[validate] windowed kernel ready (W=%d). Run ./ludkey_cuda --bench to measure.\n", WIN); return 0; }

  // Puzzle #72 target hash160 (checksum-verified in the TS core).
  const char* TARGET_HEX = "bf7413e8df4e7a34ce9dc13e2f2648783ec54adb";
  uint8_t target[20]; for (int i = 0; i < 20; ++i) sscanf(TARGET_HEX + i*2, "%2x", (unsigned*)&target[i]);

  // Standalone production search: random 2^25 segments, shared progress with the
  // Go CPU agent (run both together for CPU+GPU combined throughput).
  for (int i = 1; i < argc; ++i) if (strcmp(argv[i], "--standalone") == 0) return runStandalone(target);

  // Sustained-average benchmark for fair A/B: --avgbench [seconds] (default 30).
  for (int i = 1; i < argc; ++i) if (strcmp(argv[i], "--avgbench") == 0) {
    double secs = (i + 1 < argc) ? atof(argv[i+1]) : 30.0; if (secs <= 0) secs = 30.0;
    return runAvgBench(target, secs);
  }

  // Pool worker driven by the Go agent over stdin (coordinator stays in Go).
  for (int i = 1; i < argc; ++i) if (strcmp(argv[i], "--serve") == 0) return runServe(target);

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
  int threads = TPB;
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
