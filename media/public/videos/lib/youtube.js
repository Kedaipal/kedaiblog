/*
 * YouTube links — the long-video half of the page (clips go to R2).
 *
 * VIDEO_YOUTUBE_RE is copied VERBATIM from the blog's Video block
 * (js/sanity.js and studio/schemaTypes/VideoLinkInput.jsx, Kedaipal/kedaiblog#4).
 * If it changes there it must change here, or the page would hand out a link
 * the Studio refuses. test/youtube.test.mjs pins the accepted shapes.
 */

export const VIDEO_YOUTUBE_RE = /^https:\/\/(?:(?:www\.|m\.)?youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/|www\.youtube-nocookie\.com\/embed\/)([A-Za-z0-9_-]{11})(?=$|[?&#/])\S*$/

/**
 * Any accepted YouTube link → {id, short, canonical, thumbnail}, else null.
 * `canonical` is what the page hands out: https://www.youtube.com/watch?v=<id>.
 */
export function parseYouTubeLink(input) {
  const link = String(input ?? '').trim()
  const m = VIDEO_YOUTUBE_RE.exec(link)
  if (!m) return null
  const id = m[1]
  return {
    id,
    short: /\/shorts\//.test(link),
    canonical: `https://www.youtube.com/watch?v=${id}`,
    thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  }
}
