# LudKey Hunter — CUDA agent (NVIDIA)

GPU search backend for Puzzle #72. **This source was not compiled or run in the
environment where it was written (no NVIDIA GPU / CUDA toolkit there).** It is a
correct-by-design reference that mirrors the CPU engine proven in
`packages/core` and `packages/engine`, and it **validates itself on your GPU
before searching**.

## Build

Requires an NVIDIA GPU and the CUDA toolkit (`nvcc`). Set `SM` to your card:

| GPU | `SM=` | Notes |
|---|---|---|
| GTX 1650 | 75 | Turing |
| RTX 3070 | 86 | Ampere |
| RTX 5070 / 5090 | 120 | Blackwell — needs CUDA 12.8+ |

```bash
make SM=75              # GTX 1650. Add WIN=96 etc. to set the window size.
make validate          # runs the GPU-vs-CPU self-test only (incl. the windowed kernel)
./ludkey_cuda --bench  # measure throughput on your GPU
```

## Kernel: windowed batch inversion

Each thread computes its base point once, then derives `WIN-1` consecutive keys
by affine point addition with a **single** modular inversion per window (the same
amortised scheme proven in `packages/web-webgpu/model/kernel.mjs`, which is
checked against per-key scalar multiplication across the #72 range). This removes
the per-key scalar multiplication and per-key field inversion.

Tune `WIN` per GPU and compare the measured Mkey/s:

```bash
make clean && make SM=75 WIN=32 && ./ludkey_cuda --bench
make clean && make SM=75 WIN=64 && ./ludkey_cuda --bench
make clean && make SM=75 WIN=96 && ./ludkey_cuda --bench
```

Larger `WIN` amortises the base point and the inversion over more keys, but uses
more per-thread memory. If a launch prints a kernel error, lower `WIN`.

## The self-test gate (why you can trust it)

At startup the program computes hash160 on the GPU for four keys whose correct
hash160 values come from the tested CPU reference:

```
key 0x1   -> 751e76e8199196d454941c45d1b3a323f1433bd6
key 0x3   -> 7dd65592d0ab2fe0d0257d571abf032cd9db93dc
key 0x15  -> 8f9dff39a81ee4abcbad2ad8bafff090415a2be8
key 0x202 -> d7729816650e581d7462d52ad6f732da0e2ec93b
```

If the GPU disagrees with any of them, the program prints `FAIL` and **exits
without searching**. Do not trust any result unless you see `[validate] PASS`.

## Run

```bash
./ludkey_cuda                                  # validate + local throughput bench
./ludkey_cuda --server http://<host>:8071      # join a coordinated search
```

## Design notes / honest limitations

- The reference kernel computes `key·G` from scratch per thread (clear and
  verifiable). The **batch-addition trick** used by the CPU engine (one modular
  inverse amortized across a window via Montgomery's trick) is the documented
  optimization for ~10–100× more throughput; wire it in before production use.
- 256-bit field arithmetic uses 8×32-bit limbs with secp256k1 fast reduction.
  The self-test exercises the full field→EC→hash pipeline, so a reduction bug
  surfaces immediately as a self-test FAIL rather than a silent wrong answer.
- For a battle-tested production GPU engine you may also cross-check against
  mature open-source tools (keyhunt, BitCrack); this agent is designed to be
  readable and self-verifying first.
