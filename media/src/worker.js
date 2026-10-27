/*
 * admin.kedaipal.com/videos — get a video into a blog post.
 *
 *   Clips up to 5 minutes  → R2 (bucket kedaipal-media, public at media.kedaipal.com),
 *                            uploaded through this Worker in 10 MB parts.
 *   Longer videos          → our YouTube channel; this page guides the upload and
 *                            checks the resulting link can be embedded.
 *
 * Login is the Kedaipal app's Clerk login; who may use the page is decided by
 * the main app's Convex (`adminAccess:mine` must return "videos"). The HTML/CSS/
 * JS shell is public; every /videos/api/* call needs a Clerk `convex` token:
 *   1. verify it locally (src/clerk.js)           → 401
 *   2. ask Convex for the caller's areas (src/access.js) → 403 without "videos",
 *      503 when Convex can't answer (never a pass)
 *   3. only then touch R2 or YouTube.
 *
 * Routes (all under /videos, so this can later be a route on the admin app):
 *   GET  /                             → 302 /videos
 *   GET  /videos, /videos/recent, /videos/sign-in   the page shell
 *   GET  /videos/config.js             public config (publishable key …)
 *   GET  /videos/api/me                {userId, areas, allowed}
 *   POST /videos/api/r2/create         reserve a never-overwritten key, start multipart
 *   PUT  /videos/api/r2/part?key&uploadId&n   one ≤ 10 MB part
 *   POST /videos/api/r2/complete       finish (refuses if the key appeared meanwhile)
 *   POST /videos/api/r2/abort          give up
 *   PUT  /videos/api/r2/poster?key     the captured JPEG
 *   GET  /videos/api/youtube?url=      can this YouTube video be embedded?
 *   GET  /videos/api/recent            the last 20 clips
 *   GET  /videos/dev-media/<key>       LOCAL DEV ONLY (SERVE_MEDIA=1): serves the
 *                                      local bucket, standing in for media.kedaipal.com
 */
import {AuthError, bearerToken, parseList, verifyClerkToken} from './clerk.js'
import {AccessUnavailable, adminAreas} from './access.js'
import {checkYouTubeLink} from './youtube.js'
import {
  CLIP_MAX_BYTES,
  PART_SIZE,
  POSTER_KEY_RE,
  VIDEO_KEY_RE,
  VIDEOS_AREA,
  clipLink,
  monthFolder,
  normaliseName,
  pickFreeName,
  posterKey,
  videoKey,
} from '../public/videos/lib/shared.js'

const SHELL_PATHS = new Set(['/videos', '/videos/', '/videos/recent', '/videos/sign-in'])
const REQUIRED_VARS = ['CLERK_PUBLISHABLE_KEY', 'CLERK_ISSUER', 'CLERK_AUTHORIZED_PARTIES', 'CONVEX_URL', 'PUBLIC_MEDIA_BASE']
const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable'
const MAX_PART_BYTES = PART_SIZE + 1024
const MAX_POSTER_BYTES = 4 * 1024 * 1024
const MAX_PARTS = Math.ceil(CLIP_MAX_BYTES / PART_SIZE)

/* ---------- helpers ---------- */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'},
  })
}
const fail = (status, code, message, extra = {}) => json({error: code, message, ...extra}, status)

async function readJson(request, limit = 16 * 1024) {
  const text = await request.text()
  if (text.length > limit) throw new Error('body too large')
  return JSON.parse(text || '{}')
}

const missingVars = (env) => REQUIRED_VARS.filter((k) => !env[k])
const publicBase = (env) => String(env.PUBLIC_MEDIA_BASE).replace(/\/+$/, '')
const flag = (v) => String(v ?? '') === '1'

/* ---------- auth gate ---------- */

/** → {claims, areas} or a Response to return as-is. */
async function authorise(request, env) {
  const token = bearerToken(request)
  if (!token) return fail(401, 'signed-out', 'Sign in to continue.')
  let claims
  try {
    claims = await verifyClerkToken(token, {issuer: env.CLERK_ISSUER, authorizedParties: parseList(env.CLERK_AUTHORIZED_PARTIES)})
  } catch (err) {
    if (!(err instanceof AuthError)) throw err
    return fail(401, 'signed-out', 'Your sign-in has expired. Reload the page to sign in again.')
  }
  try {
    const areas = await adminAreas({convexUrl: env.CONVEX_URL, token, sub: claims.sub})
    return {claims, areas}
  } catch (err) {
    if (!(err instanceof AccessUnavailable)) throw err
    console.error(err.message)
    return fail(503, 'access-unavailable', 'Could not check your access right now. Try again in a minute.')
  }
}

/* ---------- R2: clips ---------- */

async function r2Create(request, env, auth) {
  let body
  try {
    body = await readJson(request)
  } catch {
    return fail(400, 'bad-request', 'Bad request body')
  }
  const {fileName, size, duration, width, height} = body
  if (typeof fileName !== 'string' || !fileName.trim()) return fail(400, 'bad-request', 'fileName is required')
  if (!Number.isInteger(size) || size <= 0) return fail(400, 'bad-request', 'size is required')
  if (size > CLIP_MAX_BYTES) return fail(413, 'too-large', 'Too large for a clip this length — export at 1080p or 720p.')

  const month = monthFolder()
  const wanted = normaliseName(fileName)
  const exists = async (name) => {
    const [v, p] = await Promise.all([env.MEDIA.head(videoKey(month, name)), env.MEDIA.head(posterKey(month, name))])
    return Boolean(v || p)
  }
  const {name, suffixed} = await pickFreeName(wanted, exists)
  const key = videoKey(month, name)
  const pKey = posterKey(month, name)

  const customMetadata = {originalName: fileName.slice(0, 200), uploadedBy: auth.claims.sub}
  if (Number.isFinite(duration) && duration > 0) customMetadata.duration = String(Math.round(duration * 100) / 100)
  if (Number.isFinite(width) && Number.isFinite(height)) customMetadata.dimensions = `${width}x${height}`

  const upload = await env.MEDIA.createMultipartUpload(key, {
    httpMetadata: {contentType: 'video/mp4', cacheControl: CACHE_IMMUTABLE},
    customMetadata,
  })
  return json({
    key,
    posterKey: pKey,
    uploadId: upload.uploadId,
    name,
    wantedName: wanted,
    suffixed,
    partSize: PART_SIZE,
    url: clipLink(publicBase(env), key),
  })
}

async function r2Part(request, url, env) {
  const key = url.searchParams.get('key') || ''
  const uploadId = url.searchParams.get('uploadId') || ''
  const n = Number(url.searchParams.get('n'))
  if (!VIDEO_KEY_RE.test(key) || !uploadId) return fail(400, 'bad-request', 'Bad key or uploadId')
  if (!Number.isInteger(n) || n < 1 || n > MAX_PARTS) return fail(400, 'bad-request', 'Part number out of range')
  const length = Number(request.headers.get('content-length'))
  if (!Number.isFinite(length) || length <= 0 || length > MAX_PART_BYTES) return fail(413, 'too-large', 'Part too large')
  try {
    const part = await env.MEDIA.resumeMultipartUpload(key, uploadId).uploadPart(n, await request.arrayBuffer())
    return json({partNumber: part.partNumber, etag: part.etag})
  } catch (err) {
    return fail(502, 'storage', `Storage refused part ${n}: ${err.message}`)
  }
}

async function r2Complete(request, env) {
  let body
  try {
    body = await readJson(request, 512 * 1024)
  } catch {
    return fail(400, 'bad-request', 'Bad request body')
  }
  const {key, uploadId, parts} = body
  if (!VIDEO_KEY_RE.test(key || '') || !uploadId || !Array.isArray(parts) || !parts.length) return fail(400, 'bad-request', 'key, uploadId and parts are required')
  const clean = parts.map((p) => ({partNumber: Number(p.partNumber), etag: String(p.etag ?? '')}))
  if (clean.some((p) => !Number.isInteger(p.partNumber) || !p.etag)) return fail(400, 'bad-request', 'Malformed parts list')

  const upload = env.MEDIA.resumeMultipartUpload(key, uploadId)
  // Never overwrite — even if the name was taken between create and now.
  if (await env.MEDIA.head(key)) {
    await upload.abort().catch(() => {})
    return fail(409, 'taken', 'A clip with this name appeared while you were uploading. Upload again to get a new name.')
  }
  try {
    const object = await upload.complete(clean)
    return json({key, url: clipLink(publicBase(env), key), size: object.size})
  } catch (err) {
    return fail(502, 'storage', `Could not finish the upload: ${err.message}`)
  }
}

async function r2Abort(request, env) {
  let body
  try {
    body = await readJson(request)
  } catch {
    return fail(400, 'bad-request', 'Bad request body')
  }
  if (!VIDEO_KEY_RE.test(body.key || '') || !body.uploadId) return fail(400, 'bad-request', 'key and uploadId are required')
  await env.MEDIA.resumeMultipartUpload(body.key, body.uploadId).abort().catch(() => {})
  return json({aborted: true})
}

async function r2Poster(request, url, env) {
  const key = url.searchParams.get('key') || ''
  if (!POSTER_KEY_RE.test(key)) return fail(400, 'bad-request', 'Bad poster key')
  // The poster belongs to a clip that already exists — never a free-standing image.
  if (!(await env.MEDIA.head(key.replace(/\.jpg$/, '.mp4')))) return fail(409, 'no-clip', 'Upload the clip first')
  const length = Number(request.headers.get('content-length'))
  if (!Number.isFinite(length) || length <= 0 || length > MAX_POSTER_BYTES) return fail(413, 'too-large', 'Poster too large')
  if (await env.MEDIA.head(key)) return fail(409, 'taken', 'Poster already exists')
  await env.MEDIA.put(key, await request.arrayBuffer(), {httpMetadata: {contentType: 'image/jpeg', cacheControl: CACHE_IMMUTABLE}})
  return json({key, url: clipLink(publicBase(env), key)})
}

async function recentClips(env, limit = 20) {
  const objects = []
  let cursor
  for (let page = 0; page < 10; page++) {
    const res = await env.MEDIA.list({prefix: 'videos/', include: ['customMetadata'], limit: 1000, cursor})
    objects.push(...res.objects)
    if (!res.truncated) break
    cursor = res.cursor
  }
  const posters = new Set(objects.filter((o) => POSTER_KEY_RE.test(o.key)).map((o) => o.key))
  const base = publicBase(env)
  const clips = objects
    .filter((o) => VIDEO_KEY_RE.test(o.key)) // skips videos/_test/ and anything we didn't write
    .sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded))
    .slice(0, limit)
    .map((o) => {
      const jpg = o.key.replace(/\.mp4$/, '.jpg')
      return {
        name: o.key.slice('videos/'.length, -'.mp4'.length),
        link: clipLink(base, o.key),
        poster: posters.has(jpg) ? clipLink(base, jpg) : null,
        size: o.size,
        duration: Number(o.customMetadata?.duration) || null,
        uploaded: o.uploaded,
      }
    })
  return json({clips})
}

/* ---------- local dev: serve the local bucket ---------- */

async function devMedia(request, url, env) {
  const key = decodeURIComponent(url.pathname.slice('/videos/dev-media/'.length))
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

/* ---------- static ---------- */

function configScript(env) {
  const config = {
    clerkPublishableKey: env.CLERK_PUBLISHABLE_KEY || '',
    appUrl: env.APP_URL || 'https://kedaipal.com/app',
    missing: missingVars(env),
  }
  // `npm run dev:offline` only: a token minted by the local mock issuer. Exposed
  // solely while the issuer itself is on localhost, so it can never surface on a
  // deployed Worker (whose issuer is clerk.kedaipal.com and would reject it anyway).
  if (env.DEV_OFFLINE_TOKEN && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(String(env.CLERK_ISSUER))) {
    config.offline = {token: env.DEV_OFFLINE_TOKEN, name: 'Offline tester', email: 'offline@localhost'}
  }
  return new Response(`window.ADMIN_VIDEOS_CONFIG = ${JSON.stringify(config)};\n`, {
    headers: {'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store'},
  })
}

async function asset(env, request, path) {
  const res = await env.ASSETS.fetch(new Request(new URL(path, request.url), request))
  const headers = new Headers(res.headers)
  headers.set('cache-control', 'no-store')
  headers.set('x-robots-tag', 'noindex')
  headers.set('referrer-policy', 'same-origin')
  return new Response(res.body, {status: res.status, headers})
}

/* ---------- entry ---------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const {pathname} = url
    const method = request.method

    if (pathname === '/') return Response.redirect(new URL('/videos', url).toString(), 302)

    if (pathname.startsWith('/videos/api/')) {
      const missing = missingVars(env)
      if (missing.length) return fail(503, 'not-configured', `Not configured: ${missing.join(', ')}`)
      try {
        const auth = await authorise(request, env)
        if (auth instanceof Response) return auth
        const allowed = auth.areas.includes(VIDEOS_AREA)
        if (pathname === '/videos/api/me' && method === 'GET') return json({userId: auth.claims.sub, areas: auth.areas, allowed})
        if (!allowed) return fail(403, 'no-access', "You don't have admin access.")
        if (pathname === '/videos/api/r2/create' && method === 'POST') return r2Create(request, env, auth)
        if (pathname === '/videos/api/r2/part' && method === 'PUT') return r2Part(request, url, env)
        if (pathname === '/videos/api/r2/complete' && method === 'POST') return r2Complete(request, env)
        if (pathname === '/videos/api/r2/abort' && method === 'POST') return r2Abort(request, env)
        if (pathname === '/videos/api/r2/poster' && method === 'PUT') return r2Poster(request, url, env)
        if (pathname === '/videos/api/youtube' && method === 'GET') return json(await checkYouTubeLink(url.searchParams.get('url')))
        if (pathname === '/videos/api/recent' && method === 'GET') return recentClips(env)
        return fail(404, 'not-found', 'No such endpoint')
      } catch (err) {
        console.error(`${method} ${pathname} failed:`, err)
        return fail(500, 'internal', 'Something went wrong on our side. Try again.')
      }
    }

    if (method !== 'GET' && method !== 'HEAD') return new Response('Method not allowed', {status: 405})
    if (pathname.startsWith('/videos/dev-media/')) return flag(env.SERVE_MEDIA) ? devMedia(request, url, env) : new Response('Not found', {status: 404})
    if (pathname === '/videos/config.js') return configScript(env)
    if (SHELL_PATHS.has(pathname)) return asset(env, request, '/videos/index.html')
    if (pathname.startsWith('/videos/')) return asset(env, request, pathname)
    return new Response('Not found', {status: 404, headers: {'content-type': 'text/plain'}})
  },
}
