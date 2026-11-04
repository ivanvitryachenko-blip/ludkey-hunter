# LudKey Hunter — Cloudflare coordinator (puzzle #72)

An **always-on, serverless** coordination server on Cloudflare's edge. No home
PC, no port forwarding, no fixed IP. One link is both the app and the shared
coordinator: open it on your phone and every computer, and they split the #72
range into non-overlapping **2²⁵ segments** and search together.

## What runs where

- **Worker** (`src/worker.js`) — handles `/api/*` and serves the web app.
- **Durable Object `Coordinator`** — one global instance that owns the range
  allocator. Because every API request routes to that single instance,
  leasing/completing segments is atomic: **no two devices ever get the same
  segment** (the allocator is a line-for-line port of the Node server's
  `allocator.ts`, which passes the no-overlap / full-coverage / crash-recovery
  / 8000-op stress tests in `packages/server/test/allocator.test.ts`).
- Found keys are stored **only** in private Durable Object storage and are
  never returned by any endpoint.

## Deploy (3 commands, free plan)

```bash
npm i -g wrangler     # once
wrangler login        # authorize in your browser
wrangler deploy       # prints https://ludkey-hunter.<you>.workers.dev
```

Durable Objects with **SQLite storage are free-tier eligible**, so the default
Workers (free) plan is enough. Open the printed URL on all your devices — it
defaults to the collaborative (Connected) mode and talks to the same-origin
coordinator automatically.

## Verify before trusting it

This Worker was **not** run on a Cloudflare account in the authoring
environment. Check it locally first:

```bash
wrangler dev          # http://localhost:8787
# in another shell:
curl localhost:8787/api/info            # #72 params
curl localhost:8787/api/status          # 0 done at first
```

Then confirm the segment math against the tested core:
`chunkCount` for 2²⁵ over the 2⁷¹-wide #72 range is **2⁴⁶** (`0x400000000000`).

## API (same shape as the Node server)

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/api/info` | GET | — | puzzle #, address, hash160, range, segment size |
| `/api/status` | GET | — | aggregate progress + device list (no keys) |
| `/api/register` | POST | — | returns `{deviceId, token}` |
| `/api/lease` | POST | Bearer | lease the next free segment |
| `/api/heartbeat` | POST | Bearer | report speed / renew lease |
| `/api/complete` | POST | Bearer | mark a segment done |
| `/api/release` | POST | Bearer | give a segment back |
| `/api/match` | POST | Bearer | report a found key (stored privately) |

## Notes

- To reset all progress, delete the Durable Object's storage (re-deploy with a
  new `class_name`, or `wrangler d1`/DO storage reset), or change the range —
  the coordinator discards any stored state whose range isn't #72.
- Segment size is 2²⁵ by default; override with `CHUNK_BITS` in
  `wrangler.toml` `[vars]`.
