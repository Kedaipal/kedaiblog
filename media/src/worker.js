/*
 * upload.kedaipal.com — the Kedaipal blog's video upload Worker.
 *
 * Every request passes the Cloudflare Access JWT check first (src/access.js);
 * only then does it reach a route. Static files (the page, its CSS/JS) come
 * from the `ASSETS` binding with `run_worker_first: true`, so they are gated
 * too. There is no `workers.dev` route and the JWT check would fail on one
 * anyway: Access only signs requests that arrive via upload.kedaipal.com.
 *
 * Routes
 *   GET  /                       the upload page (static)
 *   GET  /recent                 last 20 clips (R2) + last 20 Stream videos
 *   GET  /api/me                 who is signed in + what is configured
 *   POST /r2/create              reserve a never-overwritten key, start multipart
 *   PUT  /r2/part?key&uploadId&n  one 10 MB part (body = bytes)
 *   POST /r2/complete            finish the multipart upload
 *   POST /r2/abort               give up (parts are discarded)
 *   PUT  /r2/poster?key          the captured JPEG poster
 *   POST /stream/direct-upload   ask Stream for a tus upload URL
 *   GET  /stream/status?uid      poll until readyToStream
 *   GET  /media/<key>            LOCAL DEV ONLY: serve an R2 object (no
 *                                media.kedaipal.com in `wrangler dev`)
 */
import {tokenFromRequest, verifyAccessJwt, AccessError} from './access.js'
import {createDirectUpload, getVideo, listVideos, streamConfigured, customerCodeFrom, StreamError} from './stream.js'
import {errorJson, json, notConfiguredPage, recentPage, unauthorizedJson, unauthorizedPage} from './pages.js'
import {
  PART_SIZE,
  POSTER_KEY_RE,
  STREAM_UID_RE,
  VIDEO_KEY_RE,
  clipLink,
  monthFolder,
  normaliseName,
  pickFreeName,
  posterKey,
  streamLink,
  streamThumbnail,
  videoKey,
} from '../public/lib/names.js'

const CACHE_CONTROL_IMMUTABLE = 'public, max-age=31536000, immutable'
const MAX_PART_BYTES = PART_SIZE + 1024 // a little slack for the last part's rounding
const MAX_POSTER_BYTES = 4 * 1024 * 1024
const MAX_PARTS = 10000

/* ---------- helpers ---------- */

/**
 * `npm run dev` passes `--var ACCESS_DEV_BYPASS:1` (and blanks ACCESS_AUD).
 * The bypass only works while ACCESS_AUD is EMPTY — i.e. on a Worker that is
 * not configured for Access at all, which in production is a 503 anyway. A
 * configured, deployed Worker can therefore never be bypassed, whatever vars
 * someone types into the dashboard. (Checking the hostname instead would not
 * work: wrangler dev rewrites it to the route's domain.)
 */
function devBypass(env) {
  // String(): wrangler's --var hands "1" over as the number 1.
  return String(env.ACCESS_DEV_BYPASS) === '1' && !env.ACCESS_AUD
}

function wantsJson(url) {
  return url.pathname.startsWith('/r2/') || url.pathname.startsWith('/stream/') || url.pathname.startsWith('/api/')
}

function publicBase(env) {
  return (env.PUBLIC_MEDIA_BASE || 'https://media.kedaipal.com').replace(/\/+$/, '')
}

async function readJson(request, limit = 64 * 1024) {
  const text = await request.text()
  if (text.length > limit) throw new Error('body too large')
  return JSON.parse(text || '{}')
}

/* ---------- R2 path ---------- */

async function r2Create(request, env, claims) {
  let body
  try {
    body = await readJson(request)
  } catch {
    return errorJson(400, 'Bad request body')
  }
  const {fileName, size, duration, width, height} = body
  if (typeof fileName !== 'string' || !Number.isFinite(size) || size <= 0) return errorJson(400, 'fileName and size are required')

  const month = monthFolder()
  const wanted = normaliseName(fileName)
  const exists = async (name) => {
    const [v, p] = await Promise.all([env.MEDIA.head(videoKey(month, name)), env.MEDIA.head(posterKey(month, name))])
    return Boolean(v || p)
  }
  const {name, suffixed} = await pickFreeName(wanted, exists)
  const key = videoKey(month, name)
  const pKey = posterKey(month, name)

  const customMetadata = {
    originalName: fileName.slice(0, 200),
    uploadedBy: String(claims.email || ''),
  }
  if (Number.isFinite(duration)) customMetadata.duration = String(Math.round(duration * 100) / 100)
  if (Number.isFinite(width) && Number.isFinite(height)) customMetadata.dimensions = `${width}x${height}`

  const upload = await env.MEDIA.createMultipartUpload(key, {
    httpMetadata: {contentType: 'video/mp4', cacheControl: CACHE_CONTROL_IMMUTABLE},
    customMetadata,
  })

  return json({
    key,
    posterKey: pKey,
    uploadId: upload.uploadId,
    name,
    suffixed,
    wantedName: wanted,
    partSize: PART_SIZE,
    url: clipLink(publicBase(env), key),
    posterUrl: clipLink(publicBase(env), pKey),
  })
}

async function r2Part(request, url, env) {
  const key = url.searchParams.get('key') || ''
  const uploadId = url.searchParams.get('uploadId') || ''
  const n = Number(url.searchParams.get('n'))
  if (!VIDEO_KEY_RE.test(key) || !uploadId) return errorJson(400, 'Bad key or uploadId')
  if (!Number.isInteger(n) || n < 1 || n > MAX_PARTS) return errorJson(400, 'Part number out of range')
  const length = Number(request.headers.get('content-length'))
  if (!Number.isFinite(length) || length <= 0 || length > MAX_PART_BYTES) return errorJson(413, 'Part too large')

  const upload = env.MEDIA.resumeMultipartUpload(key, uploadId)
  try {
    const bytes = await request.arrayBuffer()
    const part = await upload.uploadPart(n, bytes)
    return json({partNumber: part.partNumber, etag: part.etag})
  } catch (err) {
    return errorJson(502, `Storage refused part ${n}: ${err.message}`)
  }
}

async function r2Complete(request, env) {
  let body
  try {
    body = await readJson(request)
  } catch {
    return errorJson(400, 'Bad request body')
  }
  const {key, uploadId, parts} = body
  if (!VIDEO_KEY_RE.test(key || '') || !uploadId || !Array.isArray(parts) || !parts.length) return errorJson(400, 'key, uploadId and parts are required')
  const clean = parts.map((p) => ({partNumber: Number(p.partNumber), etag: String(p.etag)}))
  if (clean.some((p) => !Number.isInteger(p.partNumber) || !p.etag)) return errorJson(400, 'Malformed parts list')

  const upload = env.MEDIA.resumeMultipartUpload(key, uploadId)
  // Never overwrite — even if something slipped in between /r2/create and now.
  if (await env.MEDIA.head(key)) {
    await upload.abort().catch(() => {})
    return errorJson(409, 'A file with this name appeared while you were uploading. Start the upload again to get a new name.')
  }
  try {
    const object = await upload.complete(clean)
    return json({key, url: clipLink(publicBase(env), key), size: object.size, etag: object.httpEtag})
  } catch (err) {
    return errorJson(502, `Could not finish the upload: ${err.message}`)
  }
}

async function r2Abort(request, env) {
  let body
  try {
    body = await readJson(request)
  } catch {
    return errorJson(400, 'Bad request body')
  }
  const {key, uploadId} = body
  if (!VIDEO_KEY_RE.test(key || '') || !uploadId) return errorJson(400, 'key and uploadId are required')
  await env.MEDIA.resumeMultipartUpload(key, uploadId).abort().catch(() => {})
  return json({aborted: true})
}

async function r2Poster(request, url, env) {
  const key = url.searchParams.get('key') || ''
  if (!POSTER_KEY_RE.test(key)) return errorJson(400, 'Bad poster key')
  const length = Number(request.headers.get('content-length'))
  if (!Number.isFinite(length) || length <= 0 || length > MAX_POSTER_BYTES) return errorJson(413, 'Poster too large')
  if (await env.MEDIA.head(key)) return errorJson(409, 'Poster already exists')
  const bytes = await request.arrayBuffer()
  await env.MEDIA.put(key, bytes, {httpMetadata: {contentType: 'image/jpeg', cacheControl: CACHE_CONTROL_IMMUTABLE}})
  return json({key, url: clipLink(publicBase(env), key)})
}

/* ---------- Stream path ---------- */

function customerCode(env, fallbackUrl) {
  return env.STREAM_CUSTOMER_CODE || customerCodeFrom(fallbackUrl) || ''
}

async function streamDirectUpload(request, env) {
  if (!streamConfigured(env)) return errorJson(503, 'Stream is not connected to this page yet (STREAM_API_TOKEN is missing). Ask Zaki.')
  let body
  try {
    body = await readJson(request)
  } catch {
    return errorJson(400, 'Bad request body')
  }
  const {fileName, size} = body
  if (typeof fileName !== 'string' || !Number.isInteger(size) || size <= 0) return errorJson(400, 'fileName and size are required')
  try {
    const {uploadURL, uid} = await createDirectUpload(env, {name: fileName.slice(0, 200), size})
    return json({uploadURL, uid})
  } catch (err) {
    return errorJson(err instanceof StreamError ? 502 : 500, err.message, {detail: err.detail})
  }
}

async function streamStatus(url, env) {
  if (!streamConfigured(env)) return errorJson(503, 'Stream is not configured')
  const uid = url.searchParams.get('uid') || ''
  if (!STREAM_UID_RE.test(uid)) return errorJson(400, 'Bad uid')
  try {
    const v = await getVideo(env, uid)
    const code = customerCode(env, v.thumbnail || v.preview)
    return json({
      uid,
      readyToStream: Boolean(v.readyToStream),
      state: v.status?.state || 'unknown',
      pctComplete: v.status?.pctComplete ?? null,
      errorReasonCode: v.status?.errorReasonCode || null,
      errorReasonText: v.status?.errorReasonText || null,
      duration: typeof v.duration === 'number' && v.duration > 0 ? v.duration : null,
      size: v.size ?? null,
      link: code ? streamLink(code, uid) : null,
      thumbnail: code ? streamThumbnail(code, uid) : v.thumbnail || null,
    })
  } catch (err) {
    return errorJson(err instanceof StreamError ? 502 : 500, err.message)
  }
}

/* ---------- /recent ---------- */

async function listRecentClips(env, limit = 20) {
  const objects = []
  let cursor
  for (let page = 0; page < 10; page++) {
    const res = await env.MEDIA.list({prefix: 'videos/', include: ['customMetadata'], limit: 1000, cursor})
    objects.push(...res.objects)
    if (!res.truncated) break
    cursor = res.cursor
  }
  const posters = new Set(objects.filter((o) => o.key.endsWith('.jpg')).map((o) => o.key))
  const base = publicBase(env)
  return objects
    .filter((o) => o.key.endsWith('.mp4'))
    .sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded))
    .slice(0, limit)
    .map((o) => {
      const jpg = o.key.replace(/\.mp4$/, '.jpg')
      return {
        name: o.key.slice('videos/'.length).replace(/\.mp4$/, ''),
        link: clipLink(base, o.key),
        poster: posters.has(jpg) ? clipLink(base, jpg) : null,
        size: o.size,
        duration: Number(o.customMetadata?.duration),
        uploaded: o.uploaded,
      }
    })
}

async function recent(env, claims) {
  const clips = await listRecentClips(env)
  let stream = null
  let streamError = null
  if (streamConfigured(env)) {
    try {
      const videos = await listVideos(env, 20)
      stream = videos.map((v) => {
        const code = customerCode(env, v.thumbnail || v.preview)
        return {
          uid: v.uid,
          name: v.meta?.name || v.uid,
          link: code ? streamLink(code, v.uid) : v.preview || '',
          thumbnail: code ? streamThumbnail(code, v.uid) : v.thumbnail || null,
          duration: v.duration > 0 ? v.duration : NaN,
          created: v.created,
          ready: Boolean(v.readyToStream),
        }
      })
    } catch (err) {
      stream = []
      streamError = err.message
    }
  }
  return recentPage({clips, stream, streamError, email: claims.email || ''})
}

/* ---------- local-dev media server ---------- */

async function serveMedia(request, url, env) {
  const key = decodeURIComponent(url.pathname.slice('/media/'.length))
  if (!VIDEO_KEY_RE.test(key) && !POSTER_KEY_RE.test(key)) return new Response('Not found', {status: 404})
  const range = request.headers.get('range')
  const object = request.method === 'HEAD' ? await env.MEDIA.head(key) : await env.MEDIA.get(key, range ? {range: request.headers} : undefined)
  if (!object) return new Response('Not found', {status: 404})
  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('accept-ranges', 'bytes')
  headers.set('etag', object.httpEtag)
  if (request.method === 'HEAD') {
    headers.set('content-length', String(object.size))
    return new Response(null, {headers})
  }
  if (range && object.range) {
    const start = object.range.offset ?? 0
    const end = object.range.length != null ? start + object.range.length - 1 : object.size - 1
    headers.set('content-range', `bytes ${start}-${end}/${object.size}`)
    headers.set('content-length', String(end - start + 1))
    return new Response(object.body, {status: 206, headers})
  }
  headers.set('content-length', String(object.size))
  return new Response(object.body, {headers})
}

/* ---------- entry ---------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const apiLike = wantsJson(url)

    // 1. Who is this?
    let claims
    if (devBypass(env)) {
      claims = {email: 'dev@localhost', sub: 'dev'}
    } else {
      const missing = ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD'].filter((k) => !env[k])
      if (missing.length) return apiLike ? errorJson(503, `Not configured: ${missing.join(', ')}`) : notConfiguredPage(missing)
      const token = tokenFromRequest(request)
      try {
        claims = await verifyAccessJwt(token, {teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD})
      } catch (err) {
        if (!(err instanceof AccessError)) throw err
        return apiLike ? unauthorizedJson() : unauthorizedPage()
      }
    }

    // 2. Route.
    const {pathname} = url
    const method = request.method
    try {
      if (pathname === '/api/me' && method === 'GET') {
        return json({
          email: claims.email || '',
          streamConfigured: streamConfigured(env),
          publicMediaBase: publicBase(env),
          localDev: devBypass(env),
        })
      }
      if (pathname === '/recent' && method === 'GET') return recent(env, claims)
      if (pathname === '/r2/create' && method === 'POST') return r2Create(request, env, claims)
      if (pathname === '/r2/part' && method === 'PUT') return r2Part(request, url, env)
      if (pathname === '/r2/complete' && method === 'POST') return r2Complete(request, env)
      if (pathname === '/r2/abort' && method === 'POST') return r2Abort(request, env)
      if (pathname === '/r2/poster' && method === 'PUT') return r2Poster(request, url, env)
      if (pathname === '/stream/direct-upload' && method === 'POST') return streamDirectUpload(request, env)
      if (pathname === '/stream/status' && method === 'GET') return streamStatus(url, env)
      if (pathname.startsWith('/media/') && (method === 'GET' || method === 'HEAD') && devBypass(env)) return serveMedia(request, url, env)
      if (apiLike) return errorJson(404, 'No such endpoint')
    } catch (err) {
      console.error(`${method} ${pathname} failed:`, err)
      return apiLike ? errorJson(500, 'Something went wrong on our side. Try again.') : new Response('Internal error', {status: 500})
    }

    // 3. Static files — the page and its assets. Never cached by the browser:
    // they sit behind a login and change with every deploy.
    if (method !== 'GET' && method !== 'HEAD') return new Response('Method not allowed', {status: 405})
    const res = await env.ASSETS.fetch(request)
    const headers = new Headers(res.headers)
    headers.set('cache-control', 'no-store')
    headers.set('x-robots-tag', 'noindex')
    return new Response(res.body, {status: res.status, headers})
  },
}
