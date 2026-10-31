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
 */
import {isYouTubePlaylist, parseYouTubeLink} from '../public/videos/lib/youtube.js'

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
    res = await fetchImpl(`${OEMBED}?url=${encodeURIComponent(parsed.canonical)}&format=json`, {
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
  return {
    status: 'ok',
    video: {
      ...base,
      title: String(body.title || '').slice(0, 300),
      channel: String(body.author_name || '').slice(0, 200),
      // oEmbed's own thumbnail is the same image; keep ours so the host is fixed.
    },
  }
}
