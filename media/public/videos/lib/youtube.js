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
 * A YouTube link that carries a playlist but no single video (playlist?list=,
 * watch?list= without v=, embed/videoseries?list=). Consulted only after
 * parseYouTubeLink has refused a link, to say why. Same as PR #4's Studio
 * (VideoLinkInput.jsx), copied verbatim.
 */
export const YOUTUBE_PLAYLIST_RE = /^https:\/\/(?:(?:www\.|m\.)?youtube\.com|youtu\.be|www\.youtube-nocookie\.com)\/\S*[?&]list=/

/** A Short is decided by its path only, never by "/shorts/" anywhere in the text. */
const SHORTS_PATH_RE = /^https:\/\/(?:www\.|m\.)?youtube\.com\/shorts\//

/**
 * Any accepted YouTube link → {id, short, canonical, thumbnail}, else null.
 * `canonical` is what the page hands out: https://www.youtube.com/watch?v=<id>.
 * Mirrors PR #4's parseVideoLink: `embed/videoseries?list=…` matches the regex
 * with id "videoseries" but is a playlist, so it is refused.
 */
export function parseYouTubeLink(input) {
  const link = String(input ?? '').trim()
  const m = VIDEO_YOUTUBE_RE.exec(link)
  if (!m || m[1] === 'videoseries') return null
  const id = m[1]
  return {
    id,
    short: SHORTS_PATH_RE.test(link),
    canonical: `https://www.youtube.com/watch?v=${id}`,
    thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  }
}

/** A refused link that is a playlist (so the page can say so, not "not a YouTube link"). */
export function isYouTubePlaylist(input) {
  return YOUTUBE_PLAYLIST_RE.test(String(input ?? '').trim())
}
