/*
 * Small pure helpers shared by the browser (app.js), the Worker (src/) and the
 * tests. No DOM, no bindings.
 */

/** Stream refuses anything longer than this (set per upload as maxDurationSeconds). */
export const STREAM_MAX_SECONDS = 3 * 60 * 60

/** Stream's own ceiling for a single upload. */
export const STREAM_MAX_BYTES = 30 * 1024 ** 3

/** Stream video uids are 32 lowercase hex characters. */
export const STREAM_UID_RE = /^[0-9a-f]{32}$/

/** The permission area this page needs (Convex `adminAccess:mine` → areas). */
export const VIDEOS_AREA = 'videos'

/**
 * The one link the page hands back — byte-for-byte what the Studio's Video
 * block accepts (Kedaipal/kedaiblog#4, `VIDEO_STREAM_RE` in js/sanity.js).
 */
export function streamLink(customerCode, uid) {
  return `https://customer-${customerCode}.cloudflarestream.com/${uid}/iframe`
}
export function streamThumbnail(customerCode, uid) {
  return `https://customer-${customerCode}.cloudflarestream.com/${uid}/thumbnails/thumbnail.jpg`
}

/** The Clerk Frontend API host encoded in a publishable key (pk_live_… / pk_test_…). */
export function frontendApiFromKey(publishableKey) {
  const m = /^pk_(?:live|test)_([A-Za-z0-9+/=_-]+)$/.exec(String(publishableKey || ''))
  if (!m) return null
  try {
    const decoded = atob(m[1].replace(/-/g, '+').replace(/_/g, '/'))
    return decoded.endsWith('$') ? decoded.slice(0, -1) : null
  } catch {
    return null
  }
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = h ? String(m).padStart(2, '0') : String(m)
  return `${h ? h + ':' : ''}${mm}:${String(sec).padStart(2, '0')}`
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}
