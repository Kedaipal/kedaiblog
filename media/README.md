# upload.kedaipal.com — video uploads for the blog

A small Cloudflare Worker that lets blog writers drop a video and get back
**one link** to paste into the Studio's Video block. It decides where the file
goes, checks it will play, grabs a poster frame and never overwrites anything.

| Duration | Goes to | Link it hands back |
|---|---|---|
| ≤ 5 min | R2 bucket `kedaipal-media`, served from `media.kedaipal.com` (free) | `https://media.kedaipal.com/videos/<yyyy-mm>/<name>.mp4` (+ `<name>.jpg` poster beside it) |
| > 5 min | Cloudflare Stream (transcoded, adaptive, billed per minute) | `https://customer-<code>.cloudflarestream.com/<uid>/iframe` |

The one override: **Send to Stream anyway** on a short clip that must play
smoothly on poor connections. A long video never goes to R2.

Design and decisions: ClickUp [z8r3fdwwpe](https://app.clickup.com/t/z8r3fdwwpe)
(parent) and [z8r3fdx50u](https://app.clickup.com/t/z8r3fdx50u) (this Worker).

## How it is protected

Cloudflare Access sits in front of `upload.kedaipal.com` (one-time PIN by
email, allow-list of writers). Access is only the login screen: **the Worker
verifies the Access JWT on every request itself** (`src/access.js` — RS256
against the team's published keys, `aud`, `iss`, `exp`). No `workers.dev`
address exists, and a request without a valid token gets the 401 page, static
files included (`run_worker_first` sends every request through the check).

## Layout

| Path | What |
|---|---|
| `wrangler.jsonc` | Worker config: route, R2 binding, assets, the plain-text vars |
| `src/worker.js` | Routes: `/r2/*` multipart upload, `/stream/*` direct-creator upload + status, `/recent`, `/api/me` |
| `src/access.js` | Access JWT verification |
| `src/stream.js` | Stream API calls (token stays server-side) |
| `src/pages.js` | Server-rendered pages: 401, 503 (not configured), `/recent` |
| `public/` | The page itself: `index.html`, `upload.css`, `app.js` (every state), `recent.js` |
| `public/lib/names.js` | Naming + routing rules, shared by browser, Worker and tests |
| `public/lib/mp4.js` | Fast-start probe (`moov` before `mdat`), shared the same way |
| `public/lib/tus.js` | A 100-line tus client for the browser → Stream upload |
| `test/` | `node --test` suites; `test/fixtures/` holds the two probe MP4s |
| `scripts/make-fixtures.mjs` | Regenerates the fixtures (no ffmpeg needed) |

## Run locally

```bash
cd media
npm install
npm run dev          # http://localhost:8787 — local R2 simulator, Access bypassed
npm test             # name rules, routing boundaries, fast-start probe, JWT rejection
```

`npm run dev` passes `--var ACCESS_DEV_BYPASS:1 --var ACCESS_AUD:` so the page
opens without a login. The bypass only works while `ACCESS_AUD` is empty, i.e.
on a Worker that is not configured for Access — a deployed, configured Worker
cannot be bypassed. Clip links point at `http://localhost:8787/media/…`, a
dev-only route that serves the local bucket.

The Stream path needs a real token even locally: put
`STREAM_API_TOKEN=…` in `media/.dev.vars` (gitignored). Without it the page
says Stream is not connected and the R2 path still works.

## Deploying (operator steps — ClickUp subtask 1 §D)

Never run `wrangler deploy` from a laptop. Cloudflare Workers Builds deploys
this folder on every push to `main`:

1. Workers → Create → import `Kedaipal/blog` as a **second** Worker named
   `kedaipal-upload`, root directory `media/`, build command `npm ci`, deploy
   command `npx wrangler deploy`. Turn **off** non-production (preview) builds
   for this Worker — previews would run outside Access.
2. Fill the three empty vars in `wrangler.jsonc` in a normal PR:
   `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` (Access application → Overview),
   `STREAM_CUSTOMER_CODE` (any Stream video's embed snippet). They are declared
   in the file because `wrangler deploy` replaces dashboard vars with the ones
   in the file. Until they are set the Worker answers 503 for everything.
3. Set the secret `STREAM_API_TOKEN` (a token with only *Stream : Edit*) on the
   Worker: Settings → Variables and Secrets, or `npx wrangler secret put
   STREAM_API_TOKEN` from this folder.
4. `workers.dev` route: off (also `workers_dev: false` here).
5. Access application for `upload.kedaipal.com` with the writers' emails.

## Tests

- `test/names.test.mjs` — normalisation, `-2`/`-3` suffixing, 299/300/301 s
  routing boundaries, key/link shapes (the contract with the Video block).
- `test/mp4.test.mjs` — the probe on both fixtures plus awkward layouts
  (64-bit sizes, moov past the 2 MB window, size-0 boxes, corrupt sizes).
- `test/access.test.mjs` — a JWT signed by a generated key is accepted; bad
  aud, expired, unsigned (`alg: none`), wrong key, unknown kid, tampered
  payload, wrong issuer and not-yet-valid tokens are rejected.
