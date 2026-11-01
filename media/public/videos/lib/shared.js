/*
 * The rules of the page, as pure functions shared by the browser (app.js), the
 * Worker (src/) and the tests. No DOM, no bindings.
 *
 * The Worker is the authority on names and keys: whatever the page shows, the
 * key is recomputed server-side from the original file name, so a tampered
 * request can never write outside videos/<yyyy-mm>/.
 */

/** Clips up to and including this many seconds go to R2; longer ones to YouTube. */
export const CLIP_MAX_SECONDS = 300

/** Hard ceiling for a clip (bytes). */
export const CLIP_MAX_BYTES = 2 * 1024 ** 3

/** Multipart part size. Well under the 100 MB Worker request-body limit. */
export const PART_SIZE = 10 * 1024 * 1024

export const NAME_MAX = 60

/** The permission area this page needs (Convex `adminAccess:mine` → areas). */
export const VIDEOS_AREA = 'videos'

/** Where long videos are uploaded (the Kedaipal channel; the writer switches to it there). */
export const YOUTUBE_STUDIO_URL = 'https://studio.youtube.com'

/**
 * The routing rule. ≤ 5 min → "clip" (R2), > 5 min → "youtube".
 * A duration the browser could not read is "unknown" — the page refuses such a
 * file for R2 (it won't play for readers either) and offers YouTube.
 */
export function decideDestination(durationSeconds) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 'unknown'
  return durationSeconds <= CLIP_MAX_SECONDS ? 'clip' : 'youtube'
}

/**
 * File name → object name: lowercase, spaces/underscores → "-", only
 * [a-z0-9-], extension dropped, runs of "-" collapsed, ≤ 60 chars, no
 * leading/trailing "-". "video" when nothing survives.
 */
export function normaliseName(fileName) {
  let base = String(fileName ?? '')
  const dot = base.lastIndexOf('.')
  if (dot > 0) base = base.slice(0, dot)
  base = base
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, NAME_MAX)
    .replace(/-+$/g, '')
  return base || 'video'
}

/** "yyyy-mm" in Malaysian time, so the folder matches the writer's calendar. */
export function monthFolder(date = new Date(), timeZone = 'Asia/Kuala_Lumpur') {
  const parts = new Intl.DateTimeFormat('en-GB', {timeZone, year: 'numeric', month: '2-digit'})
    .formatToParts(date)
    .reduce((acc, p) => ((acc[p.type] = p.value), acc), {})
  return `${parts.year}-${parts.month}`
}

export const videoKey = (month, name) => `videos/${month}/${name}.mp4`
export const posterKey = (month, name) => `videos/${month}/${name}.jpg`

/** Only keys the Worker itself would have generated are ever touched. */
export const VIDEO_KEY_RE = /^videos\/\d{4}-\d{2}\/[a-z0-9][a-z0-9-]{0,59}\.mp4$/
export const POSTER_KEY_RE = /^videos\/\d{4}-\d{2}\/[a-z0-9][a-z0-9-]{0,59}\.jpg$/

/**
 * Never overwrite: the first of name, name-2, name-3 … for which `exists`
 * resolves false. Suffixing keeps the total within NAME_MAX.
 */
export async function pickFreeName(name, exists, limit = 100) {
  if (!(await exists(name))) return {name, suffixed: false}
  for (let n = 2; n <= limit; n++) {
    const suffix = `-${n}`
    const candidate = name.slice(0, NAME_MAX - suffix.length).replace(/-+$/g, '') + suffix
    if (!(await exists(candidate))) return {name: candidate, suffixed: true}
  }
  throw new Error(`No free name for "${name}" after ${limit} tries`)
}

/**
 * A clip's public link — byte-for-byte what the Studio's Video block accepts
 * (Kedaipal/kedaiblog#4): https://media.kedaipal.com/videos/<yyyy-mm>/<name>.mp4
 */
export function clipLink(publicBase, key) {
  return `${String(publicBase).replace(/\/+$/, '')}/${key}`
}

/**
 * Where the page's "way out" points. Someone with a store (owner or team
 * member) goes back to the app. Someone without one would be sent by the app
 * into "create your store" onboarding — a dead end for a blog editor — so they
 * get the site's home instead. A missing `hasStore` (older Convex) counts as no.
 */
export function wayOut(hasStore, appUrl) {
  if (hasStore === true) return {href: appUrl, label: 'Kedaipal app', menu: 'Go to the Kedaipal app'}
  let home = 'https://kedaipal.com'
  try {
    home = new URL(appUrl).origin
  } catch {
    /* keep the default */
  }
  return {href: home, label: home.replace(/^https?:\/\//, ''), menu: `Go to ${home.replace(/^https?:\/\//, '')}`}
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
