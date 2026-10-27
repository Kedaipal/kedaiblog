/*
 * Cloudflare Stream API calls made by the Worker. The API token never leaves
 * the server; the browser only ever talks to the one-time tus URL Stream
 * hands back, so video bytes never pass through this Worker.
 *
 * Direct creator upload, tus flavour: POST /accounts/{id}/stream?direct_user=true
 * with tus headers creates the video and returns `Location` (the resumable
 * upload URL) and `stream-media-id` (the uid). (/stream/direct_upload is the
 * other variant: a single multipart/form-data POST capped at 200 MB — no use
 * for a 45-minute podcast.)
 *
 * Every video is created with:
 *   maxDurationSeconds  3 h (Stream refuses anything longer)
 *   allowedorigins      blog.kedaipal.com only — manifests/segments refuse to
 *                       play anywhere else; thumbnails are not restricted
 *   requiresignedurls   omitted → false (a public blog)
 *   Upload-Creator      the uploader's Clerk user id
 */
import {STREAM_MAX_SECONDS} from '../public/videos/lib/shared.js'

const API = 'https://api.cloudflare.com/client/v4'

export class StreamError extends Error {
  constructor(status, message, detail) {
    super(message)
    this.status = status
    this.detail = detail
  }
}

function b64(s) {
  const bytes = new TextEncoder().encode(String(s))
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

export function streamConfigured(env) {
  return Boolean(env.STREAM_API_TOKEN && env.CF_ACCOUNT_ID)
}

function streamFetch(env, path, init = {}) {
  return fetch(`${API}/accounts/${env.CF_ACCOUNT_ID}${path}`, {
    ...init,
    headers: {Authorization: `Bearer ${env.STREAM_API_TOKEN}`, ...(init.headers || {})},
  })
}

/** The tus `Upload-Metadata` header: comma-separated `key base64(value)` pairs. */
export function uploadMetadata({name, allowedOrigins}) {
  const pairs = [`name ${b64(name)}`, `maxDurationSeconds ${b64(STREAM_MAX_SECONDS)}`]
  if (allowedOrigins.length) pairs.push(`allowedorigins ${b64(allowedOrigins.join(','))}`)
  return pairs.join(',')
}

/**
 * Create a tus direct-creator upload. Returns {uploadURL, uid}.
 * @param {object} env
 * @param {{name: string, size: number, creator: string, allowedOrigins: string[]}} o
 */
export async function createDirectUpload(env, {name, size, creator, allowedOrigins}) {
  const res = await streamFetch(env, '/stream?direct_user=true', {
    method: 'POST',
    headers: {
      'Tus-Resumable': '1.0.0',
      'Upload-Length': String(size),
      'Upload-Creator': creator,
      'Upload-Metadata': uploadMetadata({name, allowedOrigins}),
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

export async function getVideo(env, uid) {
  const res = await streamFetch(env, `/stream/${uid}`)
  const body = await res.json().catch(() => null)
  if (!res.ok || !body?.success) throw new StreamError(res.status, `Stream lookup failed (${res.status})`, body?.errors)
  return body.result
}

/** Newest first. */
export async function listVideos(env, perPage = 20) {
  const res = await streamFetch(env, `/stream?per_page=${perPage}&asc=false`)
  const body = await res.json().catch(() => null)
  if (!res.ok || !body?.success) throw new StreamError(res.status, `Stream list failed (${res.status})`, body?.errors)
  return body.result ?? []
}

/** customer-<code> from any Stream playback URL; fallback when STREAM_CUSTOMER_CODE is empty. */
export function customerCodeFrom(url) {
  const m = String(url || '').match(/^https:\/\/customer-([a-z0-9]+)\.cloudflarestream\.com\//)
  return m ? m[1] : null
}
