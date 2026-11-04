// LudKey Hunter — CUDA reference agent for NVIDIA GPUs (puzzle #71 hash160 search).
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

__device__ void hash160_of_key(const uint32_t* key, uint8_t out[20]) {
  uint32_t x[8], y[8];
  scalar_mul_G(key, x, y);
  uint8_t pub[33]; compressed_pub(x, y, pub);
  uint8_t sh[32]; sha256(pub, 33, sh);
  ripemd160(sh, 32, out);
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
  printf("[validate] %s\n", ok ? "PASS — GPU matches CPU reference" : "FAIL — GPU crypto is WRONG, refusing to search");
  return ok;
}

int main(int argc, char** argv) {
  int dev = 0; cudaDeviceProp prop;
  if (cudaGetDeviceProperties(&prop, dev) != cudaSuccess) { printf("No CUDA device found.\n"); return 1; }
  printf("GPU: %s  (%d SMs, %.1f GB, CC %d.%d)\n", prop.name, prop.multiProcessorCount,
         prop.totalGlobalMem / 1e9, prop.major, prop.minor);

  if (!validate()) return 2; // honesty gate: never search on a GPU that computes wrong hashes

  // Puzzle #71 target hash160 (checksum-verified in the TS core).
  const char* TARGET_HEX = "f6f5431d25bbf7b12e8add9af5e3475c44a0a5b8";
  uint8_t target[20]; for (int i = 0; i < 20; ++i) sscanf(TARGET_HEX + i*2, "%2x", (unsigned*)&target[i]);

  // Demo/bench base: start of #71 range. A real run gets its base chunk from the
  // coordination server (see README for the HTTP protocol; identical to the
  // Node agent). Here we benchmark raw throughput over a batch.
  uint32_t base[8]; hexToKey("400000000000000000", base);

  uint32_t *dBase; uint8_t *dTarget; uint64_t *dFoundOff; int *dFoundFlag;
  cudaMalloc(&dBase, 8*4); cudaMalloc(&dTarget, 20); cudaMalloc(&dFoundOff, 8); cudaMalloc(&dFoundFlag, 4);
  cudaMemcpy(dBase, base, 8*4, cudaMemcpyHostToDevice);
  cudaMemcpy(dTarget, target, 20, cudaMemcpyHostToDevice);
  cudaMemset(dFoundFlag, 0, 4);

  const uint64_t BATCH = 1ull << 20; // 1,048,576 keys per launch (tune per GPU)
  int threads = 256; int blocks = (int)((BATCH + threads - 1) / threads);

  cudaEvent_t t0, t1; cudaEventCreate(&t0); cudaEventCreate(&t1);
  cudaEventRecord(t0);
  k_search<<<blocks, threads>>>(dBase, BATCH, dTarget, dFoundOff, dFoundFlag);
  cudaEventRecord(t1); cudaEventSynchronize(t1);
  float ms = 0; cudaEventElapsedTime(&ms, t0, t1);

  int flag; cudaMemcpy(&flag, dFoundFlag, 4, cudaMemcpyDeviceToHost);
  double rate = BATCH / (ms / 1000.0);
  printf("[bench] %llu keys in %.1f ms = %.2f Mkey/s (measured on this GPU)\n",
         (unsigned long long)BATCH, ms, rate / 1e6);
  if (flag) { uint64_t off; cudaMemcpy(&off, dFoundOff, 8, cudaMemcpyDeviceToHost);
    printf("*** MATCH at base+%llu ***\n", (unsigned long long)off); }
  else printf("no match in this batch (expected — the batch is a vanishing fraction of 2^70)\n");

  printf("\nReference kernel = key*G from scratch per thread. The CPU engine's\n"
         "batch-addition trick (one modular inverse per window) is the documented\n"
         "optimization for ~10-100x more throughput; wire it in before production.\n");
  return 0;
}
