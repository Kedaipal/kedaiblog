/*
 * Cloudflare Stream API calls made by the Worker (never by the browser — the
 * API token stays server-side). The browser only ever talks to the tus upload
 * URL that Stream hands back, so video bytes never pass through this Worker.
 *
 * Direct creator upload, tus flavour:
 *   POST /accounts/{id}/stream?direct_user=true with tus headers creates the
 *   video and returns `Location` (the one-time, resumable upload URL) and
 *   `stream-media-id` (the uid). The /stream/direct_upload endpoint would
 *   return a one-time URL too, but that one only takes a single
 *   multipart/form-data POST of up to 200 MB — useless for a 20-minute MOV.
 */

export const STREAM_MAX_DURATION_SECONDS = 3 * 60 * 60 // 3 h

const API = 'https://api.cloudflare.com/client/v4'

export class StreamError extends Error {
  constructor(status, message, detail) {
    super(message)
    this.status = status
    this.detail = detail
  }
}

function b64(s) {
  return btoa(unescape(encodeURIComponent(String(s))))
}

export function streamConfigured(env) {
  return Boolean(env.STREAM_API_TOKEN && env.CF_ACCOUNT_ID)
}

async function streamFetch(env, path, init = {}) {
  const res = await fetch(`${API}/accounts/${env.CF_ACCOUNT_ID}${path}`, {
    ...init,
    headers: {Authorization: `Bearer ${env.STREAM_API_TOKEN}`, ...(init.headers || {})},
  })
  return res
}

/**
 * Create a tus direct-creator upload. Returns {uploadURL, uid}.
 * @param {object} env
 * @param {{name: string, size: number}} file
 */
export async function createDirectUpload(env, {name, size}) {
  const res = await streamFetch(env, '/stream?direct_user=true', {
    method: 'POST',
    headers: {
      'Tus-Resumable': '1.0.0',
      'Upload-Length': String(size),
      'Upload-Metadata': [
        `name ${b64(name)}`,
        `maxDurationSeconds ${b64(STREAM_MAX_DURATION_SECONDS)}`,
      ].join(','),
    },
  })
  if (res.status !== 201) {
    const text = await res.text().catch(() => '')
    throw new StreamError(res.status, `Stream refused the upload (${res.status})`, text.slice(0, 500))
  }
  const uploadURL = res.headers.get('Location')
  const uid = res.headers.get('stream-media-id')
  if (!uploadURL || !uid) throw new StreamError(502, 'Stream did not return an upload URL')
  return {uploadURL, uid}
}

/** Fetch one video's details: readyToStream, status, duration, thumbnail … */
export async function getVideo(env, uid) {
  const res = await streamFetch(env, `/stream/${uid}`)
  const body = await res.json().catch(() => null)
  if (!res.ok || !body?.success) {
    throw new StreamError(res.status, `Stream lookup failed (${res.status})`, body?.errors)
  }
  return body.result
}

/** Most recent videos, newest first. */
export async function listVideos(env, perPage = 20) {
  const res = await streamFetch(env, `/stream?per_page=${perPage}&asc=false`)
  const body = await res.json().catch(() => null)
  if (!res.ok || !body?.success) {
    throw new StreamError(res.status, `Stream list failed (${res.status})`, body?.errors)
  }
  return body.result ?? []
}

/**
 * The customer code from a Stream playback URL, e.g.
 * https://customer-abc123.cloudflarestream.com/<uid>/thumbnails/thumbnail.jpg → "abc123".
 * Used only as a fallback when STREAM_CUSTOMER_CODE is not set.
 */
export function customerCodeFrom(url) {
  const m = String(url || '').match(/^https:\/\/customer-([a-z0-9]+)\.cloudflarestream\.com\//)
  return m ? m[1] : null
}
