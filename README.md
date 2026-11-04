# LudKey Hunter

A research platform for **Bitcoin Puzzle #72** — a public cryptographic challenge
whose creator deliberately placed funds at an address with a private key in a
known range (`[2⁷¹, 2⁷²−1]`) for anyone to find. LudKey Hunter searches that
published range with verified cryptography, runs on any device from a browser,
and can coordinate several of your own devices so they never duplicate work.

Target address: `1JTK7s9YVYywfm5XUH7RNhHJH1LshCaRFR`
Target hash160: `bf7413e8df4e7a34ce9dc13e2f2648783ec54adb` (Base58Check-verified at startup)

## Search together from any device (one click, no terminal)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ivanvitryachenko-blip/ludkey-hunter/tree/main/packages/cloudflare)

Deploys an always-on coordinator to **your** Cloudflare account (free plan is
enough). It gives you one public URL that is both the app and the shared
coordinator — open it on your phone and PCs and they split the range into
non-overlapping 2²⁵ segments and search together. Details: [`packages/cloudflare/README.md`](packages/cloudflare/README.md).

---

## ⚠️ Read this first — honest reality check

Puzzle #72 has a **2⁷¹ keyspace ≈ 2.36 × 10²¹ keys**. This is not a get-rich
scheme; it is closer to a lottery with astronomically small odds.

| Hardware | Rate (measured / typical) | Time to exhaust 2⁷¹ |
|---|---|---|
| This project's CPU reference, 1 thread (measured here) | **~0.16 Mkey/s** | ~476 million years |
| One modern gaming GPU (industry ballpark) | ~10³–10⁴ Mkey/s | ~10³–10⁵ years |
| 1,000,000 coordinated GPUs | — | ~2 years |

Puzzle #72's **public key is not exposed** on-chain (the address has never sent
a transaction), so fast methods that need the public key — Pollard's Kangaroo,
BSGS — **do not apply**. Only brute-force over the hash160 is possible, which is
what every tool here does. The numbers above are the honest consequence.

Everything this project reports is **measured**, never faked. No simulated GPU
load, no invented statistics, no fabricated test results.

---

## The live web app

The browser engine is published and runs on any device (phone, tablet, Mac, PC):

- Verifies its own secp256k1 / SHA-256 / RIPEMD-160 against known vectors **in
  your browser** on load (green "crypto verified" badge).
- Real search in a pool of Web Workers — one disjoint sub-range per worker, so
  no thread repeats another's work.
- Live, measured stats and charts; honest GPU panel (browsers cannot read GPU
  temperature / utilization / VRAM, so those are shown as "not exposed", never
  faked).
- **Demo mode** hides a known key in a small window and the engine actually
  finds it — proof the whole pipeline works end to end.

It computes on CPU Web Workers (portable, verified, works on iOS Safari). GPU
acceleration is the CUDA agent and the WebGPU module below.

---

## What is verified vs. what needs your hardware

**Verified in this build (96 automated tests, all passing):**

```
crypto core          25/25   secp256k1, SHA-256, RIPEMD-160, addresses, #72 target
CPU search engine    12/12   finds hidden keys, boundaries, resume, no false positives
range allocator      21/21   tiles 2⁷¹, no overlap, crash recovery, 8000-op stress
server integration   14/14   registration, auth, disjoint leasing, found-key privacy
claim / tx signing   13/13   WIF, RFC6979 ECDSA (cross-checked by Node), signed sweep tx
```

Measured CPU throughput (this environment, 1 thread, BigInt reference core):
**~157,000 keys/s**. The browser engine with a worker pool scales roughly
linearly with cores.

**Provided as source, validated on *your* hardware (not built here — the build
environment has no NVIDIA GPU and no browser GPU):**

- `packages/agent-cuda` — CUDA kernels for NVIDIA GPUs. Runs a **mandatory
  GPU-vs-CPU self-test at startup and refuses to search if the GPU computes a
  wrong hash160.** Mirrors the tested CPU algorithms.
- `packages/web-webgpu` — a **full WGSL search kernel** (secp256k1 + SHA-256 +
  RIPEMD-160), now wired into the web app as a selectable GPU backend. Its
  field/EC routines are transliterated from `packages/web-webgpu/model/*`, which
  is **verified byte-for-byte against the tested CPU core** (see the
  `webgpu field/EC/pipeline model` suites). On a real GPU it still runs an
  on-device self-test (finds known keys by their known hash160) and **falls back
  to the CPU engine if WebGPU is missing or the self-test fails** — so a GPU that
  computes wrong hashes can never produce a wrong result, only no speedup.

This separation is deliberate: correctness is proven where it can be proven, and
gated by self-tests where the hardware isn't available to the author.

---

## Comparison with Krackpot

Based on Krackpot's public description (krackpot.io). Items that could not be
independently confirmed are marked as such rather than assumed.

| Capability | Krackpot | LudKey Hunter |
|---|---|---|
| Target | Puzzle #72 (same address) | Puzzle #72 (same address) |
| In-browser GPU | WebGPU (desktop browsers) | WebGPU module (self-tested) + CPU everywhere |
| Runs on phones | Not stated (desktop browsers) | Yes — CPU Web Workers on iOS/Android |
| CUDA / native agent | Not stated | Yes — NVIDIA CUDA agent (source, self-validating) |
| Multi-device coordination | **No** — "does not pool"; each device searches independently | **Yes** — server hands out non-overlapping chunks to your devices |
| Duplicate-work avoidance | Random per-device (overlap likely) | Guaranteed disjoint chunks, lease + reclaim |
| Open crypto verification | Not stated | In-browser + CI self-tests against known vectors |
| Progress save / resume | Not stated | Checkpointed per chunk, crash-safe |
| Found-key handling | Builds signed tx locally, private submission | Stored locally only, never transmitted or served |

The main design difference: Krackpot has each participant search the whole range
on their own (overlap is expected across the crowd); LudKey Hunter's coordinator
divides the range into non-overlapping chunks so **your** devices cover distinct
ground.

---

## Install & run

Requires **Node.js ≥ 22** (uses built-in TypeScript type-stripping — no build step).

```bash
git clone <this repo> && cd ludkey-hunter
npm test            # run all 72 tests
npm run bench       # measure real CPU keys/s on this machine
```

**CPU search (single machine):**
```bash
npm run demo                         # watch it find a hidden key (proof)
npm run search -- --start 400000000000000000 --end 4000000000ffffffff
# Ctrl-C saves a checkpoint; re-run the same command to resume.
```

**Coordinated multi-device search:**
```bash
# 1) on a machine reachable by your devices:
npm run server                       # http://localhost:8071
# 2) on each of your devices (PC, laptop):
npm run agent -- --server http://<server-ip>:8071 --name myrig
```
Each agent leases distinct chunks; `GET /api/status` shows aggregate progress and
per-device speed. Put the server behind TLS (reverse proxy) — do not expose a
home machine directly to the internet.

**Browser (any device):** open the published web app, or serve
`apps/web-standalone/index.html` from any static host. It is a single
self-contained file.

**NVIDIA CUDA agent:**
```bash
cd packages/agent-cuda
make SM=75        # GTX 1650=75, RTX 3070=86, RTX 5070/5090=120 (CUDA 12.8+)
make validate     # GPU-vs-CPU self-test — must PASS before trusting results
./ludkey_cuda --server http://<server-ip>:8071
```

---

## Claiming the prize (automatic sweep)

If a key is found, the tools can automatically build and **sign a sweep
transaction to your own wallet, locally** — your key never leaves the machine.
Pass `--payout <your BTC address>` (legacy `1...` or native-segwit `bc1q...`):

```bash
npm run search -- --start 4000... --end 4000... --payout bc1qyourwallet...
npm run agent  -- --server http://host:8071 --payout bc1qyourwallet...
```

On a find it fetches the address's UTXOs, builds and signs a sweep, prints your
**WIF** (importable into any wallet) and the signed raw transaction, and saves
them to `CLAIM_<address>.json`.

**It does not broadcast by default — on purpose.** Puzzle addresses are watched
by bots; a naive public broadcast can be front-run and mined by someone else,
costing you the prize. The safer path (what Krackpot does) is to submit the
signed transaction **privately** to a mining pool / accelerator. Add
`--broadcast` only if you understand and accept the public-mempool risk. The
ECDSA signer is RFC-6979 deterministic, low-S (BIP-62), and every signature it
produces is cross-verified in the test suite by Node's own secp256k1.

This is not financial or legal advice; taxes and rules depend on your country.

## Project structure

```
packages/core          verified crypto (secp256k1, sha256, ripemd160, address, puzzle)
packages/engine        CPU search engine, CLI, benchmark, Node agent
packages/server        coordination server + range allocator (lazy, scales to 2⁷¹)
packages/claim         WIF, RFC6979 ECDSA, signed sweep transaction, auto-claim
packages/agent-cuda     CUDA kernels + host validator (NVIDIA)
packages/web-webgpu    WGSL compute module + self-test
apps/web-standalone    the single-file browser app (published artifact)
scripts/run-tests.mjs  runs every suite
```

## Security & safety

- Found keys are stored **only** on the local device/server and are never
  transmitted or exposed by any API (there is a test for this).
- Devices authenticate with per-device bearer tokens.
- No private data leaves your machines; there is no telemetry.
- This searches **only** the published Puzzle #72 range. It is not, and should
  not be turned into, a tool for attacking arbitrary third-party wallets.

## Hardware support status

Support is **claimed only where verified**. The CPU engine is tested and
benchmarked here. The CUDA (GTX 1650 / RTX 3070 / RTX 5070 / RTX 5090) and
WebGPU paths are provided as self-validating source: their startup self-tests
are the gate, and you should confirm `PASS` on your own hardware before relying
on any result. No performance number in this repo is simulated.
