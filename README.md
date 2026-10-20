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
- **Body:** use the style menu for Heading, Subheading and Quote; the list buttons for bullets and numbers; and the **+** button to insert an **Image**, **Image gallery** (up to 4 images: a grid on desktop, a swipeable carousel on phones, and each opens full size when clicked), **Audio** (MP3/M4A, with an optional caption or transcript), **Tip box** or **Divider**
- **Cover when there is no image** (collapsed): the text and colour of the branded block used when no cover is uploaded

Click **Publish**. Drafts never appear on the site. New posts show within about a minute.
Categories (and their order in the filter bar) are edited under **Categories**.

## Going live

1. **Deploy the Studio** so the client can edit from anywhere:
   `cd studio && npm run deploy`, which publishes to https://kedaipal-blog.sanity.studio
2. **Invite editors:** sanity.io/manage → project → Members → Invite
3. **Host the blog:** upload everything except `studio/` to the web host.
   If it's served from a domain other than kedaipal.com / www.kedaipal.com, add it:
   `cd studio && npx sanity cors add https://your-domain.com --no-credentials`

## Notes

- After changing `styles.css` or anything in `js/`, bump the `?v=` number on those links in `index.html` and `post.html` (e.g. to today's date) so browsers download the new files instead of a cached copy.

- Articles are rendered in the browser, so search engines that don't run JavaScript won't see post text.
  For strong SEO, a later step is to pre-render pages (e.g. with Astro or Next.js) using the same queries in `js/sanity.js`.
- `npm run seed` **replaces** the sample documents (IDs `post-…`, `category-…`, `author-…`) with the versions in `js/demo-data.js`. Don't run it once the client has edited those posts.
