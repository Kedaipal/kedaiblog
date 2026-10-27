# Kedaipal Blog

A static blog (HTML/CSS/JS) styled like kedaipal.com. Posts are managed in Sanity.

- **Sanity project:** `cvycqoxz`, dataset `production` (public read), owned by kristoferkedai@gmail.com
- **Manage:** https://www.sanity.io/manage/project/cvycqoxz

## Folders

| Path | What it is |
|---|---|
| `index.html`, `post.html`, `styles.css` | The blog pages. `post.html?slug=…` shows one article |
| `js/config.js` | Sanity project ID and dataset used by the website |
| `js/sanity.js` | Fetches posts from Sanity and turns them into HTML |
| `js/demo-data.js` | Sample posts. Shown only if `projectId` in `js/config.js` is empty; also used by `npm run seed` |
| `studio/` | Sanity Studio, where posts are written |
| `tests/` | Checks for the HTML renderer (`npm test`, no dependencies) |

## Run locally

```bash
# The blog (must be served over http, not opened as a file, for Sanity to allow it)
python3 -m http.server 3000        # then open http://localhost:3000

# The Studio (in a second terminal)
cd studio
npm install                        # first time only
npm run dev                        # then open http://localhost:3333
```

## Writing posts

In the Studio, open **Posts → +** and work down the form:

- **Title**, then click **Generate** for the slug
- **Images** (each has a crop icon for setting the hotspot):
  - **Card image**, 1200 × 750 px (16:10): blog home cards and featured slot
  - **Article banner – desktop**, 1800 × 771 px (21:9): top of the article on computers and tablets
  - **Article banner – phone**, 1200 × 750 px (16:10): top of the article on phones
  - Only the card image is needed; the banners fall back to it when empty
- **Summary, category, author, publish date**
- **Feature on blog home:** puts the post in the large top slot (the newest ticked post wins)
- **Body:** use the style menu for Heading, Subheading and Quote; the list buttons for bullets and numbers; and the **+** button to insert an **Image**, **Image gallery** (up to 10 images: a grid of up to 4 on desktop with a "+N" tile for the rest, a swipeable carousel of all images on phones, and each opens full size when clicked), **Audio** (MP3/M4A, with an optional caption or transcript), **Video** (paste the link from admin.kedaipal.com/videos — see [Adding a video](#adding-a-video)), **Tip box** or **Divider**
- **Cover when there is no image** (collapsed): the text and colour of the branded block used when no cover is uploaded

Click **Publish**. Drafts never appear on the site. New posts show within about a minute.
Categories (and their order in the filter bar) are edited under **Categories**.

### Adding a video

Videos are not uploaded to Sanity (every play would count against its quota). They go to
Cloudflare Stream, which plays each one at the best quality the reader's connection can
take, so a video keeps playing on weak mobile data instead of stopping to buffer.

1. Go to <https://admin.kedaipal.com/videos> and sign in with your Kedaipal account (the
   same login as the Kedaipal app). Your account must be on the blog editors list; ask Zaki.
2. Drag the video in. Any format a phone or camera records is fine. Wait until the page
   says the video is ready (a long podcast can take several minutes), then copy the
   **one link** it gives you.
3. In the post body, press **+ → Video** and paste that link. The Studio shows
   **Stream · adaptive** and a thumbnail; anything that isn't a link from
   admin.kedaipal.com/videos is refused.
4. Optional: a **Poster** image if you want a different frame than the automatic one, a
   **Title** (shown in bold under the video) and a **Caption**.

The article reserves the right-sized box before the video loads, so the page never jumps,
and nothing autoplays. To replace a video, upload the new file and paste its new link —
the old one is never overwritten.

For the site to play Stream videos, `STREAM_CUSTOMER_CODE` in `js/config.js` must hold the
account's Stream customer code (the `customer-xxxxxxxx` part of the embed host, from the
Cloudflare dashboard → Stream → Videos). Videos are locked to play only on blog.kedaipal.com,
so a local preview on `localhost:3000` shows Stream's "not allowed" message; that is expected.

The block also understands `https://media.kedaipal.com/videos/<yyyy-mm>/<name>.mp4` links,
for clips stored on Cloudflare R2. That path is not set up today (every video goes to
Stream); it stays so clips can move to R2 later without touching published posts.

## Deployment

The blog is a **Cloudflare Worker serving static assets**, live at
<https://blog.kedaipal.com>. Every push to `main` triggers a Cloudflare Workers
Build, which runs `npm run build` and deploys `dist/`.

The custom domain is declared in `wrangler.jsonc` (`routes` with
`custom_domain: true`), so deploying creates the hostname binding and its DNS
record — there is nothing to click in the dashboard to keep it working.

| Piece | Where it lives | How it ships |
|---|---|---|
| The website | this repo | push to `main` → Cloudflare Workers Builds |
| The posts | Sanity project `cvycqoxz` | published in the Studio; live within ~a minute |
| The Studio | `studio/` in this repo | `cd studio && npm run deploy` → <https://kedaipal-blog.sanity.studio> |

`npm run build` copies **only** the public site into `dist/` — `studio/` is never
published. It is an allow-list; see the comment at the top of `build.mjs` before
adding a new top-level folder.

To deploy by hand from a clean checkout: `npm run deploy`.

### Sanity CORS — required, or the blog shows no posts

Posts are fetched from Sanity **in the browser**, so Sanity must allow the exact
origin serving the page. An origin that is not on the list gets a `403` and the
blog renders its shell with zero articles. Currently allowed: `kedaipal.com`,
`www.kedaipal.com`, `localhost:3000`, `localhost:3333`.

Adding an origin needs access to the Sanity project:

```bash
cd studio && npx sanity cors add https://blog.kedaipal.com --no-credentials
```

Or via <https://www.sanity.io/manage/project/cvycqoxz> → API → CORS origins.

### Inviting editors

sanity.io/manage → project → Members → Invite.

## Notes

- `npm test` runs the renderer checks (the Video link parser and player markup) with Node's built-in test runner.
- After changing `styles.css` or anything in `js/`, bump the `?v=` number on those links in `index.html` and `post.html` (e.g. to today's date) so browsers download the new files instead of a cached copy.

- Articles are rendered in the browser, so search engines that don't run JavaScript won't see post text.
  For strong SEO, a later step is to pre-render pages (e.g. with Astro or Next.js) using the same queries in `js/sanity.js`.
- `npm run seed` **replaces** the sample documents (IDs `post-…`, `category-…`, `author-…`) with the versions in `js/demo-data.js`. Don't run it once the client has edited those posts.
