# admin.kedaipal.com/videos — blog video uploads

A small Cloudflare Worker where blog writers drop a video and get back **one
link** to paste into the Studio's Video block. Every video goes to
**Cloudflare Stream**, which transcodes it and plays it adaptively, so it keeps
playing on weak mobile data. The link is handed out only once Stream says the
video is ready:

```
https://customer-<code>.cloudflarestream.com/<uid>/iframe
```

Each video is created with `allowedOrigins: blog.kedaipal.com` (it plays only
on the blog; thumbnails are not restricted), no signed URLs, a 3-hour limit,
and the uploader's Clerk user id as `creator`.

## Who can use it

- **Login** is the Kedaipal app's own Clerk login. The page hosts its own
  sign-in at `/videos/sign-in` (sign-in only, always back to `/videos`). Clerk
  shares the session across kedaipal.com subdomains, so signing in or out here
  does the same in the app.
- **Access** has one source of truth, the main app's Convex: the query
  `adminAccess:mine` must return the `"videos"` area. Blog editors are in the
  Convex env `BLOG_EDITOR_USER_IDS`; super-admins (`ADMIN_USER_IDS`) get it too.
  Signed in but not on the list → "You don't have admin access" with a button
  back to the app.
- **The lock is in the Worker.** The HTML/CSS/JS shell is public (no secrets,
  no data). Every `/videos/api/*` call needs a Clerk `convex`-template token,
  which the Worker verifies locally (`src/clerk.js`: RS256 against the
  instance's JWKS, `iss`, `exp`/`nbf`, `azp` = admin's origin, `aud` =
  `convex`) and then passes to Convex for the access check (`src/access.js`,
  cached a minute per user). A Convex failure is a 503, never a pass.

## Layout

| Path | What |
|---|---|
| `wrangler.jsonc` | Worker config: route, assets, the production vars |
| `src/worker.js` | Routes: `/` → `/videos`, the shell, `/videos/config.js`, `/videos/api/*` |
| `src/clerk.js` | Clerk token verification |
| `src/access.js` | The Convex `adminAccess:mine` check |
| `src/stream.js` | Stream API calls (the token stays server-side) |
| `public/videos/` | The page: `index.html`, `app.css`, `app.js` (every view), `lib/` |
| `public/videos/lib/tus.js` | A ~100-line tus client: browser → Stream, resumable |
| `test/` | `node --test` suites |

Everything lives under `/videos`, so when the admin app takes
`admin.kedaipal.com` this Worker moves to a route `admin.kedaipal.com/videos*`
without code changes.

## Run locally

```bash
cd media
npm install
npm run dev          # http://localhost:8787/videos — Clerk DEV instance + DEV Convex
npm test
```

`npm run dev` overrides the production vars with the app's **development**
Clerk instance and **dev** Convex deployment, so nothing local touches
production. To actually upload, put a Stream token in `media/.dev.vars`
(gitignored):

```
STREAM_API_TOKEN=...
STREAM_CUSTOMER_CODE=...
```

Until the main app ships `adminAccess:mine` on dev Convex, a signed-in user
gets "Could not check your access" — that is the fail-closed path working.

## Deploying (operator steps)

Never run `wrangler deploy` from a laptop.

1. **Stream:** subscribe, copy the customer code into `STREAM_CUSTOMER_CODE`
   here and in the blog's `js/config.js`, create an API token with only
   Account → Stream → Edit, and set a budget alert.
2. **After merge:** Workers → Create → import `Kedaipal/kedaiblog` as its own
   Worker `kedaipal-admin-videos`, root directory `media/`, build `npm ci`,
   deploy `npx wrangler deploy`, **preview builds off**. Set the secret
   `STREAM_API_TOKEN`. `workers.dev` is off in config. Deploying creates the
   `admin.kedaipal.com` hostname.
3. **Convex (main app):** `BLOG_EDITOR_USER_IDS` = the writers' Clerk user ids,
   and the `adminAccess:mine` query (separate main-app PR).
4. No Cloudflare Access app.

## Tests

- `test/clerk.test.mjs` — a convex-template token for admin is accepted; wrong
  `azp` (e.g. a token from the app), missing `convex` aud, expired, wrong
  issuer, unsigned, wrong key, unknown kid, tampered, not-yet-valid, no user
  are rejected; fails closed when unconfigured.
- `test/access.test.mjs` — the Convex call shape, per-user caching, and that a
  missing query or Convex outage is "unavailable", never "allowed".
- `test/worker.test.mjs` — the Worker end to end with stubbed network: 401 /
  403 / 503 paths, Stream never called without access, the tus creation
  headers, status and recent mapping.
- `test/shared.test.mjs` — the link passes the Video block's regex (copied
  verbatim from #4), publishable-key decoding, upload metadata.
