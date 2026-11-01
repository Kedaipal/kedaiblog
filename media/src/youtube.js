/*
 * "Can the blog play this YouTube video?" — checked before the writer pastes
 * the link into the Studio, so a private or embed-disabled video never reaches
 * an article as a broken player.
 *
 * YouTube's public oEmbed endpoint answers it without an API key:
 *   200  → the video exists and may be embedded (title, channel, thumbnail)
 *   401  → embedding is off, or the video is private
 *   404  → no such video (deleted, or a wrong id)
 *   400  → not a URL oEmbed understands
 * The call runs in the Worker: the browser can't read that endpoint (no CORS).
 *
 * It also tells a Short from a normal video, whichever link the writer pasted.
 * oEmbed reports the shape of the LINK FORM it is asked about, not the video:
 * asked with watch?v= or youtu.be it answers 200×113 even for a Short. Asked
 * with /shorts/<id> it answers 113×200 (portrait) for a real Short and 200×113
 * for a normal video (checked live, 31 Oct 2026). So the Worker always asks in
 * the /shorts/ form: portrait ⇒ Short. The path the writer pasted stays the
 * first signal; oEmbed is the second. If oEmbed fails, the path rule stands.
 * A Short is handed out as /shorts/<id> — the only form the blog's Video block
 * (PR #4) plays tall.
 */
import {isYouTubePlaylist, parseYouTubeLink, shortsLink, watchLink} from '../public/videos/lib/youtube.js'

export const OEMBED = 'https://www.youtube.com/oembed'

/**
 * @returns {Promise<{status: 'ok'|'not-embeddable'|'not-found'|'playlist'|'not-youtube'|'unreachable', video?: object}>}
 */
export async function checkYouTubeLink(input, {fetchImpl = fetch} = {}) {
  const parsed = parseYouTubeLink(input)
  if (!parsed) return {status: isYouTubePlaylist(input) ? 'playlist' : 'not-youtube'}
  const base = {id: parsed.id, link: parsed.canonical, short: parsed.short, thumbnail: parsed.thumbnail}

  let res
  try {
    res = await fetchImpl(`${OEMBED}?url=${encodeURIComponent(shortsLink(parsed.id))}&format=json`, {
      headers: {accept: 'application/json'},
      cf: {cacheTtl: 60},
    })
  } catch {
    return {status: 'unreachable', video: base}
  }
  if (res.status === 401 || res.status === 403) return {status: 'not-embeddable', video: base}
  if (res.status === 404 || res.status === 400) return {status: 'not-found', video: base}
  if (!res.ok) return {status: 'unreachable', video: base}

  const body = await res.json().catch(() => null)
  if (!body) return {status: 'unreachable', video: base}
  const portrait = Number(body.height) > Number(body.width)
  const short = parsed.short || portrait
  return {
    status: 'ok',
    video: {
      ...base,
      short,
      link: short ? shortsLink(parsed.id) : watchLink(parsed.id),
      title: String(body.title || '').slice(0, 300),
      channel: String(body.author_name || '').slice(0, 200),
      // oEmbed's own thumbnail is the same image; keep ours so the host is fixed.
    },
  }
}
