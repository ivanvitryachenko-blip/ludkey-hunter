# LudKey Hunter — Deno Deploy coordinator (puzzle #72)

A free, always-on coordinator on **Deno Deploy**, reachable at a
`https://<project>.deno.dev` URL. Use this when your ISP blocks Cloudflare's
`*.workers.dev` (e.g. in Russia): `deno.dev` is normally not on the blocklist.

Same behaviour as the Cloudflare coordinator: puzzle #72, **random 2²⁵ segments**
handed out with no overlap (atomic Deno-KV claim, leases auto-expire via TTL),
same REST API, and it serves the web app at `/`. Found keys are stored only in
KV and never returned by any endpoint. Verified locally with real Deno + Deno KV.

## Deploy (free, ~3 minutes, no domain needed)

1. Go to **https://dash.deno.com** and sign in with your **GitHub** account.
2. **New Project** → **Deploy from GitHub repository** → pick
   `ivanvitryachenko-blip/ludkey-hunter`.
3. Set the **Entrypoint** to:
   ```
   deno/coordinator.ts
   ```
   Leave install/build empty. KV is **built in** — nothing to enable.
4. **Deploy**. You get a URL like `https://ludkey-hunter-xxxx.deno.dev`.

Open that URL on your phone and computers → it loads the app and the
Connected (collaborative) mode talks to the same origin automatically. Nothing
to configure.

## Point the native agents at it

The Go agents take a `-server` flag:

```
# Windows
.\ludkey-agent.exe -server https://ludkey-hunter-xxxx.deno.dev
# macOS
./ludkey-agent-macos-arm64 -server https://ludkey-hunter-xxxx.deno.dev
```

(Your payout address stays baked in; add `-payout ...` to override.)

## Updating the app

The web app is embedded in `deno/app.ts` (generated from the built
`index.html`). After changing the app, regenerate it and redeploy:

```
node -e 'const fs=require("fs");fs.writeFileSync("deno/app.ts","export const APP_HTML = "+JSON.stringify(fs.readFileSync("index.html","utf8"))+";\n")'
```

Deno Deploy redeploys automatically on each push to the repo.
