# admin.kedaipal.com/videos — getting a video into a blog post

One page for every blog video. It decides where the video lives and hands back
**one link** to paste into the Studio's Video block.

| Video | Lives on | Link |
|---|---|---|
| Up to 5 minutes | R2 bucket `kedaipal-media`, served from `media.kedaipal.com` — free, no ads | `https://media.kedaipal.com/videos/<yyyy-mm>/<name>.mp4` (poster `.jpg` beside it) |
| Longer (the podcast) | the Kedaipal YouTube channel — adaptive, free | `https://www.youtube.com/watch?v=<id>` |

- **Clips** are uploaded through this Worker in 10 MB parts. They must be a
  web-ready MP4: the browser can decode it, it's an MP4 (not QuickTime), the
  `moov` box comes before `mdat` (fast start), and it's ≤ 2 GB. The page grabs a
  poster frame and never overwrites (`-2`, `-3`… when a name is taken).
- **Long videos** are uploaded in YouTube Studio; the page shows the steps. Its
  **Already on YouTube?** box checks a link through YouTube's public oEmbed
  (no API key): a private, deleted or embed-disabled video is refused there,
  before it reaches an article.
- A short clip can go to YouTube instead (**Put it on YouTube instead**) — handy
  for a MOV that can't be re-exported. A long video never goes to R2.

Decision record and link contract: ClickUp
[z8r3fdwwpe](https://app.clickup.com/t/z8r3fdwwpe) (parent) and
[z8r3fdx50u](https://app.clickup.com/t/z8r3fdx50u) (this page).

## Who can use it

- **Login** is the Kedaipal app's Clerk login; the page hosts its own sign-in at
  `/videos/sign-in` (sign-in only, always back to `/videos`).
- **Access** is one list in the main app's Convex: query `adminAccess:mine` must
  return `"videos"` (blog editors in `BLOG_EDITOR_USER_IDS`, plus super-admins).
  Signed in without it → "You don't have admin access" and a way out.
- **The way out depends on having a store.** The same query says `hasStore` (an
  owned store or an active team membership — the app's own rule). With one, the
  header reads **Kedaipal app**; without one it reads **kedaipal.com**, because
  the app would only offer a storeless blog editor "create your store". A Convex
  that predates the field counts as no store.
- **The lock is in the Worker.** The shell is public. Every `/videos/api/*` call
  carries a Clerk `convex`-template token, verified here (`src/clerk.js`: RS256
  against the instance's JWKS, `iss`, `exp`/`nbf`, `azp`, `aud`) and then checked
  with Convex (`src/access.js`, cached a minute per user). A Convex failure is a
  503, never a pass; nothing touches R2 or YouTube before both pass.

## Layout

| Path | What |
|---|---|
| `wrangler.jsonc` | route, R2 binding, assets, the (public) production vars — no secrets |
| `src/worker.js` | routes: shell, `config.js`, `/videos/api/r2/*`, `/videos/api/youtube`, `/videos/api/recent` |
| `src/clerk.js`, `src/access.js` | login token check, Convex access check |
| `src/youtube.js` | the oEmbed "can the blog embed this?" check |
| `public/videos/` | the page: `index.html`, `app.css`, `app.js` (every state), `lib/` |
| `public/videos/lib/shared.js` | routing rule, names, keys, links — shared by page, Worker and tests |
| `public/videos/lib/mp4.js` | fast-start probe |
| `public/videos/lib/youtube.js` | YouTube link parser — regex copied verbatim from the Video block |
| `scripts/dev-offline.mjs` | `npm run dev:offline` (below) |
| `test/` | `node --test` suites, MP4 fixtures, an in-memory R2 |

## Run locally

```bash
cd media
npm install
npm test
npm run dev:offline   # http://localhost:8787/videos — no accounts needed
npm run dev           # http://localhost:8787/videos — real Clerk DEV sign-in + DEV Convex
```

- **`dev:offline`** runs the real Worker and wrangler's local R2 simulator, with
  a tiny local stand-in for Clerk (a key and token generated at start) and for
  Convex (the access answer). Nothing leaves the laptop except the YouTube check.
  `-- --no-access` shows the no-access page; `-- --convex-down` the
  "could not check" page; `-- --no-store` a storeless editor (header links to
  the site instead of the app). Clips are served from
  `http://localhost:8787/videos/dev-media/…` in place of `media.kedaipal.com`.
- **`dev`** uses the app's development Clerk instance and dev Convex, so you sign
  in with a dev account. It needs `adminAccess:mine` — with `hasStore` — deployed
  on dev Convex (Kedaipal/kedaipal#423) and your dev user id in its
  `BLOG_EDITOR_USER_IDS`.

## Deploying (operator steps — ClickUp z8r3fdwwpk)

Never run `wrangler deploy` from a laptop.

1. **R2 first:** bucket `kedaipal-media` (APAC), custom domain
   `media.kedaipal.com`, `r2.dev` off. The deploy fails if the bucket is missing.
2. **Workers Builds:** import `Kedaipal/kedaiblog` as its own Worker
   `kedaipal-admin-videos`, root `media/`, build `npm ci`, deploy
   `npx wrangler deploy`, **preview builds off** (a preview would write to the real
   bucket). No secrets. The first deploy creates `admin.kedaipal.com`.
3. **YouTube:** Kris as **Manager** on the channel; "Allow embedding" on by
   default; decide about ads (YouTube Partner Program).
4. **Convex:** `BLOG_EDITOR_USER_IDS` (done on prod 27 Oct) + Kedaipal/kedaipal#423.

## Tests

- `shared.test.mjs` — routing 299 / 300 / 301 s, names, `-2`/`-3`, keys, and that
  every clip link passes the Video block's parser.
- `mp4.test.mjs` — the fast-start probe on two committed fixtures and awkward layouts.
- `youtube.test.mjs` — the regex is byte-for-byte the block's; accepted and refused
  shapes; oEmbed ok / 401 / 404 / down.
- `clerk.test.mjs`, `access.test.mjs` — token rejection cases; Convex fails closed.
- `worker.test.mjs` — the Worker end to end with an in-memory R2: the gate (401,
  403 before any R2 write, 503), multipart upload, never-overwrite including a
  race at complete, posters, abort, recent, the YouTube check.
