# LudKey Hunter — performance notes (segments / window / memory)

Measured anchor: GTX 1650 (sm_75, 14 SM, 1 MB L2) sustained **~301 Mkey/s**
(W=896, TPB=128, PTX mul + dedicated sqr). All numbers below are to be
re-measured with `--avgbench` on the actual card — nothing here is assumed.

## Where the time goes (per window of WIN keys, 1 thread)

| Phase | Cost | Notes |
|---|---|---|
| base `scalar_mul_G` (comb) | ~1 mul/key amortized | already windowed; 1 inversion inside |
| forward prefix products | 1 mul + 1 sub / key | builds the Montgomery chain; writes `prefix[]` |
| single `mod_inv` (addition chain) | ~270 mul / window | amortized over WIN keys |
| **backward recover** | **4 mul + 1 sqr + ~5 sub / key** | invdx, λ, x₃, y₃ — near-minimal for distinct affine adds |
| hash160 (SHA-256 + RIPEMD-160) | 2 full hashes / key | irreducible: target is a hash160, no pubkey, no pre-filter possible |

So per key ≈ **5 field muls + 2 hashes**, both already optimized (PTX carry-chain
mul, register-resident hashes). The field/hash compute is close to the floor.

## The two real remaining levers

### 1. Delta-table reads → read-only cache (applied)
`deltas[i]` (the iG table, ~16·(WIN-1) words) is read-only and every thread in a
warp reads the **same** `deltas[i]` at the same loop step (lock-step broadcast) —
the ideal pattern for the read-only data cache. The kernel now loads deltas via
`__ldg` (and pointers are `const __restrict__`), and loads each delta point once
per backward step instead of twice. Pure access-path change: identical values,
gated by the on-GPU self-test. Measure with `--avgbench` before/after.

### 2. Window size W — the dominant knob, and it is per-GPU
The per-thread `prefix[WIN-1][8]` array is ~`WIN·32` bytes of **local memory**
(W=896 → ~28 KB/thread). Bigger W amortizes the base `scalar_mul_G` and the one
inversion over more keys, but costs proportionally more local memory, which
spills to L1/L2/VRAM.

- On the **GTX 1650 (L2 = 1 MB)** the prefix arrays of many resident threads do
  not fit in L2, so large W spills to VRAM and hurts — the measured optimum is
  W=896.
- On a **big-L2 Blackwell card (RTX 5070, L2 ≈ 48 MB)** far more prefix state
  stays L2-resident, so a **much larger W (try 1536–4096)** can amortize the base
  multiply + inversion far better and may scale **super-linearly** vs a naive
  SM×clock estimate. This is the single most important thing to sweep on a new
  card — do not assume W=896 transfers.

Practical W ceiling: `prefix[WIN-1][8]` is compile-time; W≈4096 ≈ 128 KB/thread,
beyond which occupancy collapses on any card. Sweep W in {896, 1536, 2048, 3072}.

## Build per architecture

- GTX 1650 / Turing: `-arch=sm_75`
- RTX 5070 / Blackwell: `-arch=sm_120` (needs CUDA Toolkit ≥ 12.8)
- Keep `-DWIN=<swept> -DTPB=<swept> -DUSE_PTX_MUL -DUSE_SQR`; always re-sweep W/TPB
  per card, then confirm the winner with a sustained `--avgbench`.

## Dead ends (checked, not pursued)

- Endomorphism (×3) / point-negation symmetry (×2): give VanitySearch its speed
  for *vanity* search but **do not apply to a fixed-range puzzle** — the mirror
  keys fall outside [2⁷¹, 2⁷²).
- Montgomery multiplication: the secp256k1 prime's fast reduction (2²⁵⁶ ≡ 2³²+977)
  is already faster than REDC for this field.
- Hash pre-filter / skipping RIPEMD: impossible — the target is the post-RIPEMD
  hash160 and the public key is unknown.
- Skipping y₃: needed for the compressed-pubkey parity bit; no cheap recurrence.

Reality check unchanged: even at 2–3 Gkey/s, 2⁷¹ ≈ 2.36×10²¹ keys is tens of
thousands of years to exhaust — speed changes the lottery-ticket price, not the
odds.
