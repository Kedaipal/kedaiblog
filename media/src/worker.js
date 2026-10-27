/*
 * admin.kedaipal.com/videos — upload a video for the blog, get one Stream link.
 *
 * Login is the Kedaipal app's own Clerk login (same account, same session
 * across kedaipal.com subdomains). Who may upload is decided in ONE place,
 * the main app's Convex: `adminAccess:mine` must return the "videos" area.
 *
 *   The HTML/CSS/JS shell is public (it holds no secrets and no data).
 *   Every /videos/api/* call needs `Authorization: Bearer <Clerk convex token>`:
 *     1. verify the token locally (src/clerk.js)   → 401 if bad
 *     2. ask Convex for the caller's areas (src/access.js) → 403 without "videos"
 *     3. only then talk to Stream (src/stream.js)
 *
 * Routes (everything lives under /videos so the Worker can later move from
 * owning the whole host to a route `admin.kedaipal.com/videos*`):
 *   GET  /                          → 302 /videos
 *   GET  /videos, /videos/recent, /videos/sign-in   the page shell
 *   GET  /videos/config.js          public config for the page (publishable key …)
 *   GET  /videos/api/me             {userId, areas, allowed, streamConfigured}
 *   POST /videos/api/uploads        ask Stream for a tus upload URL
 *   GET  /videos/api/uploads/status?uid=   poll until readyToStream
 *   GET  /videos/api/recent         the last 20 Stream videos
 */
import {AuthError, bearerToken, parseList, verifyClerkToken} from './clerk.js'
import {AccessUnavailable, adminAreas} from './access.js'
import {StreamError, createDirectUpload, customerCodeFrom, getVideo, listVideos, streamConfigured} from './stream.js'
import {STREAM_MAX_BYTES, STREAM_UID_RE, VIDEOS_AREA, streamLink, streamThumbnail} from '../public/videos/lib/shared.js'

const SHELL_PATHS = new Set(['/videos', '/videos/', '/videos/recent', '/videos/sign-in'])
const REQUIRED_VARS = ['CLERK_PUBLISHABLE_KEY', 'CLERK_ISSUER', 'CLERK_AUTHORIZED_PARTIES', 'CONVEX_URL']

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

function missingVars(env) {
  return REQUIRED_VARS.filter((k) => !env[k])
}

function customerCode(env, fallbackUrl) {
  return env.STREAM_CUSTOMER_CODE || customerCodeFrom(fallbackUrl) || ''
}

function streamPctComplete(v) {
  const n = Number(v?.status?.pctComplete)
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null
}

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
  let areas
  try {
    areas = await adminAreas({convexUrl: env.CONVEX_URL, token, sub: claims.sub})
  } catch (err) {
    if (!(err instanceof AccessUnavailable)) throw err
    console.error(err.message)
    return fail(503, 'access-unavailable', 'Could not check your access right now. Try again in a minute.')
  }
  return {claims, areas}
}

function requireVideos(auth) {
  return auth.areas.includes(VIDEOS_AREA) ? null : fail(403, 'no-access', "You don't have admin access.")
}

/* ---------- API ---------- */

async function apiMe(auth, env) {
  return json({
    userId: auth.claims.sub,
    areas: auth.areas,
    allowed: auth.areas.includes(VIDEOS_AREA),
    streamConfigured: streamConfigured(env),
  })
}

async function apiCreateUpload(request, env, auth) {
  if (!streamConfigured(env)) return fail(503, 'stream-off', 'Stream is not connected yet, so videos cannot be uploaded. Ask Zaki.')
  let body
  try {
    body = await readJson(request)
  } catch {
    return fail(400, 'bad-request', 'Bad request body')
  }
  const {fileName, size} = body
  if (typeof fileName !== 'string' || !fileName.trim()) return fail(400, 'bad-request', 'fileName is required')
  if (!Number.isInteger(size) || size <= 0) return fail(400, 'bad-request', 'size is required')
  if (size > STREAM_MAX_BYTES) return fail(413, 'too-large', 'This file is over 30 GB, which is more than Stream accepts.')
  try {
    const out = await createDirectUpload(env, {
      name: fileName.trim().slice(0, 200),
      size,
      creator: auth.claims.sub,
      allowedOrigins: parseList(env.STREAM_ALLOWED_ORIGINS).map((o) => o.replace(/^https?:\/\//, '')),
    })
    return json(out)
  } catch (err) {
    if (!(err instanceof StreamError)) throw err
    console.error(err.message, err.detail)
    return fail(502, 'stream-error', `${err.message}. Try again in a minute.`)
  }
}

async function apiStatus(url, env) {
  if (!streamConfigured(env)) return fail(503, 'stream-off', 'Stream is not connected yet.')
  const uid = url.searchParams.get('uid') || ''
  if (!STREAM_UID_RE.test(uid)) return fail(400, 'bad-request', 'Bad uid')
  try {
    const v = await getVideo(env, uid)
    const code = customerCode(env, v.thumbnail || v.preview)
    return json({
      uid,
      readyToStream: Boolean(v.readyToStream),
      state: v.status?.state || 'unknown',
      pctComplete: streamPctComplete(v),
      errorReasonText: v.status?.errorReasonText || null,
      duration: typeof v.duration === 'number' && v.duration > 0 ? v.duration : null,
      size: typeof v.size === 'number' ? v.size : null,
      width: v.input?.width > 0 ? v.input.width : null,
      height: v.input?.height > 0 ? v.input.height : null,
      link: code ? streamLink(code, uid) : null,
      thumbnail: code ? streamThumbnail(code, uid) : v.thumbnail || null,
    })
  } catch (err) {
    if (!(err instanceof StreamError)) throw err
    return fail(502, 'stream-error', err.message)
  }
}

async function apiRecent(env, auth) {
  if (!streamConfigured(env)) return json({streamConfigured: false, videos: []})
  try {
    const videos = await listVideos(env, 20)
    return json({
      streamConfigured: true,
      videos: videos.map((v) => {
        const code = customerCode(env, v.thumbnail || v.preview)
        return {
          uid: v.uid,
          name: v.meta?.name || v.uid,
          link: code ? streamLink(code, v.uid) : null,
          thumbnail: code ? streamThumbnail(code, v.uid) : v.thumbnail || null,
          duration: v.duration > 0 ? v.duration : null,
          created: v.created || v.uploaded || null,
          ready: Boolean(v.readyToStream),
          failed: v.status?.state === 'error',
          mine: v.creator === auth.claims.sub,
        }
      }),
    })
  } catch (err) {
    if (!(err instanceof StreamError)) throw err
    return fail(502, 'stream-error', err.message)
  }
}

/* ---------- static ---------- */

function configScript(env) {
  const config = {
    clerkPublishableKey: env.CLERK_PUBLISHABLE_KEY || '',
    appUrl: env.APP_URL || 'https://kedaipal.com/app',
    missing: missingVars(env),
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
        if (pathname === '/videos/api/me' && method === 'GET') return apiMe(auth, env)
        const denied = requireVideos(auth)
        if (denied) return denied
        if (pathname === '/videos/api/uploads' && method === 'POST') return apiCreateUpload(request, env, auth)
        if (pathname === '/videos/api/uploads/status' && method === 'GET') return apiStatus(url, env)
        if (pathname === '/videos/api/recent' && method === 'GET') return apiRecent(env, auth)
        return fail(404, 'not-found', 'No such endpoint')
      } catch (err) {
        console.error(`${method} ${pathname} failed:`, err)
        return fail(500, 'internal', 'Something went wrong on our side. Try again.')
      }
    }

    if (method !== 'GET' && method !== 'HEAD') return new Response('Method not allowed', {status: 405})
    if (pathname === '/videos/config.js') return configScript(env)
    if (SHELL_PATHS.has(pathname)) return asset(env, request, '/videos/index.html')
    if (pathname.startsWith('/videos/')) return asset(env, request, pathname)
    return new Response('Not found', {status: 404, headers: {'content-type': 'text/plain'}})
  },
}
