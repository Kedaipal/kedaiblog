/*
 * Naming and routing rules shared by the browser (public/app.js) and the Worker
 * (src/worker.js). Pure functions, no DOM, no bindings — so they run unchanged
 * in both places and in `node --test`.
 *
 * The Worker is the authority: whatever the page shows, the key is recomputed
 * server-side from the original file name, so a tampered request cannot write
 * outside videos/<yyyy-mm>/.
 */

/** Clips up to and including this many seconds go to R2; longer ones to Stream. */
export const R2_MAX_SECONDS = 300

/** Hard ceiling for a clip on the R2 path (bytes). Longer files go to Stream anyway. */
export const R2_MAX_BYTES = 2 * 1024 * 1024 * 1024

/** Multipart part size for the R2 path. Well under the 100 MB Worker request limit. */
export const PART_SIZE = 10 * 1024 * 1024

export const NAME_MAX = 60

/**
 * Normalise a file name into the slug used as the object name.
 * lowercase, spaces → "-", strip everything but [a-z0-9-], drop the extension,
 * collapse runs of "-", trim "-" from both ends, cap at 60 chars.
 * Falls back to "video" when nothing survives.
 */
export function normaliseName(fileName) {
  let base = String(fileName ?? '')
  // Drop the extension (last dot onwards) — but only if the dot is not the
  // first character, so ".mp4" or a dotfile is not reduced to nothing.
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

/**
 * "yyyy-mm" for the folder, in Malaysian time so the month matches the
 * writer's calendar rather than UTC's (which lags by 8 hours).
 */
export function monthFolder(date = new Date(), timeZone = 'Asia/Kuala_Lumpur') {
  const parts = new Intl.DateTimeFormat('en-GB', {timeZone, year: 'numeric', month: '2-digit'})
    .formatToParts(date)
    .reduce((acc, p) => ((acc[p.type] = p.value), acc), {})
  return `${parts.year}-${parts.month}`
}

export function videoKey(month, name) {
  return `videos/${month}/${name}.mp4`
}
export function posterKey(month, name) {
  return `videos/${month}/${name}.jpg`
}

/**
 * Never overwrite: returns the first name among name, name-2, name-3 … for
 * which `exists(name)` resolves false. `exists` must check BOTH the .mp4 and
 * the .jpg (the caller passes a function that does). Suffixing keeps the total
 * length at or under NAME_MAX by trimming the base.
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
 * The routing rule. ≤ 5 min → "r2", > 5 min → "stream".
 * Duration must be a finite positive number of seconds; anything else is
 * "unknown" (the page refuses the file before it gets here).
 */
export function decideDestination(durationSeconds) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 'unknown'
  return durationSeconds <= R2_MAX_SECONDS ? 'r2' : 'stream'
}

/** Only keys the Worker itself would have generated are ever touched. */
export const VIDEO_KEY_RE = /^videos\/\d{4}-\d{2}\/[a-z0-9][a-z0-9-]{0,59}\.mp4$/
export const POSTER_KEY_RE = /^videos\/\d{4}-\d{2}\/[a-z0-9][a-z0-9-]{0,59}\.jpg$/

/** Stream video uids are 32 lowercase hex characters. */
export const STREAM_UID_RE = /^[0-9a-f]{32}$/

/**
 * The one link each kind of upload hands back — byte-for-byte what the
 * Studio's Video block accepts (ClickUp z8r3fdwwpp, "link contract").
 */
export function clipLink(publicBase, key) {
  return `${publicBase.replace(/\/+$/, '')}/${key}`
}
export function streamLink(customerCode, uid) {
  return `https://customer-${customerCode}.cloudflarestream.com/${uid}/iframe`
}
export function streamThumbnail(customerCode, uid) {
  return `https://customer-${customerCode}.cloudflarestream.com/${uid}/thumbnails/thumbnail.jpg`
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—'
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = h ? String(m).padStart(2, '0') : String(m)
  return `${h ? h + ':' : ''}${mm}:${String(sec).padStart(2, '0')}`
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—'
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
