/*
 * The Worker end to end, with the network stubbed: Clerk's JWKS, Convex's
 * query API and the Stream API all answer from here.
 */
import assert from 'node:assert/strict'
import {after, before, beforeEach, describe, it} from 'node:test'
import worker from '../src/worker.js'
import {clearAccessCache} from '../src/access.js'
import {ADMIN_ORIGIN, ISSUER, makeKey, signToken} from './helpers.mjs'

const CONVEX = 'https://dev-deployment.convex.cloud'
const UID = 'c0ffee00c0ffee00c0ffee00c0ffee00'
const AREAS = {user_writer: ['videos'], user_seller: [], user_superadmin: ['videos', 'sellers']}

const env = {
  CLERK_PUBLISHABLE_KEY: 'pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk',
  CLERK_ISSUER: ISSUER,
  CLERK_AUTHORIZED_PARTIES: ADMIN_ORIGIN,
  CONVEX_URL: CONVEX,
  CF_ACCOUNT_ID: 'acct',
  STREAM_CUSTOMER_CODE: 'abc123',
  STREAM_ALLOWED_ORIGINS: 'blog.kedaipal.com',
  STREAM_API_TOKEN: 'stream-token',
  ASSETS: {fetch: async (req) => new Response(`asset:${new URL(req.url).pathname}`, {headers: {'content-type': 'text/html'}})},
}

let key
let realFetch
let streamCalls
let convexDown = false

before(async () => {
  key = await makeKey('ins_1')
  realFetch = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input)
    if (url === `${ISSUER}/.well-known/jwks.json`) return Response.json({keys: [key.jwk]})
    if (url === `${CONVEX}/api/query`) {
      if (convexDown) return Response.json({status: 'error', errorMessage: 'boom'}, {status: 500})
      const token = init.headers.authorization.slice(7)
      const sub = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).sub
      return Response.json({status: 'success', value: {areas: AREAS[sub] ?? []}})
    }
    if (url.startsWith('https://api.cloudflare.com/client/v4/accounts/acct/stream')) {
      streamCalls.push({url, init})
      if (init.method === 'POST') return new Response(null, {status: 201, headers: {Location: `https://upload.cloudflarestream.com/tus/${UID}`, 'stream-media-id': UID}})
      if (url.endsWith(`/stream/${UID}`)) return Response.json({success: true, result: {uid: UID, readyToStream: true, status: {state: 'ready', pctComplete: '100.000000'}, duration: 2712.4, size: 812_000_000, input: {width: 1920, height: 1080}}})
      return Response.json({success: true, result: [
        {uid: UID, meta: {name: 'Episode 1.mov'}, creator: 'user_writer', readyToStream: true, duration: 2712.4, created: '2026-10-27T03:00:00Z', status: {state: 'ready'}},
        {uid: 'b'.repeat(32), meta: {name: 'Clip.mp4'}, creator: 'user_superadmin', readyToStream: false, duration: -1, created: '2026-10-27T02:00:00Z', status: {state: 'inprogress'}},
      ]})
    }
    throw new Error(`unexpected fetch ${url}`)
  }
})
after(() => (globalThis.fetch = realFetch))
beforeEach(() => {
  streamCalls = []
  convexDown = false
  clearAccessCache()
})

const call = async (path, {method = 'GET', token, body, envOverride} = {}) =>
  worker.fetch(
    new Request(`https://admin.kedaipal.com${path}`, {
      method,
      headers: {...(token ? {Authorization: `Bearer ${token}`} : {}), ...(body ? {'content-type': 'application/json'} : {})},
      body: body ? JSON.stringify(body) : undefined,
    }),
    {...env, ...envOverride},
  )
const tokenFor = (sub, claims = {}) => signToken(key, {now: Math.floor(Date.now() / 1000), claims: {sub, ...claims}})

describe('pages', () => {
  it('/ redirects to /videos', async () => {
    const res = await call('/')
    assert.equal(res.status, 302)
    assert.equal(res.headers.get('location'), 'https://admin.kedaipal.com/videos')
  })
  it('serves the same shell for /videos, /videos/recent and /videos/sign-in, never cached', async () => {
    for (const p of ['/videos', '/videos/', '/videos/recent', '/videos/sign-in']) {
      const res = await call(p)
      assert.equal(await res.text(), 'asset:/videos/index.html', p)
      assert.equal(res.headers.get('cache-control'), 'no-store')
    }
  })
  it('config.js carries only public values', async () => {
    const text = await (await call('/videos/config.js')).text()
    assert.match(text, /clerkPublishableKey/)
    assert.doesNotMatch(text, /stream-token/)
  })
  it('anything outside /videos is a 404', async () => {
    assert.equal((await call('/wp-admin')).status, 404)
  })
})

describe('API gate', () => {
  it('401 without a token, and with a token minted for another origin', async () => {
    assert.equal((await call('/videos/api/me')).status, 401)
    assert.equal((await call('/videos/api/me', {token: await tokenFor('user_writer', {azp: 'https://kedaipal.com'})})).status, 401)
  })
  it('/api/me tells a signed-in seller they are not allowed (no 403, so the page can say so)', async () => {
    const res = await call('/videos/api/me', {token: await tokenFor('user_seller')})
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), {userId: 'user_seller', areas: [], allowed: false, streamConfigured: true})
  })
  it('403 on every other endpoint without the videos area', async () => {
    const token = await tokenFor('user_seller')
    assert.equal((await call('/videos/api/uploads', {method: 'POST', token, body: {fileName: 'x.mp4', size: 10}})).status, 403)
    assert.equal((await call(`/videos/api/uploads/status?uid=${UID}`, {token})).status, 403)
    assert.equal((await call('/videos/api/recent', {token})).status, 403)
    assert.equal(streamCalls.length, 0, 'Stream must never be called for someone without access')
  })
  it('a Convex failure is 503, never a pass', async () => {
    convexDown = true
    const res = await call('/videos/api/recent', {token: await tokenFor('user_writer')})
    assert.equal(res.status, 503)
    assert.equal((await res.json()).error, 'access-unavailable')
  })
  it('503 when the Worker is deployed without its vars', async () => {
    const res = await call('/videos/api/me', {token: await tokenFor('user_writer'), envOverride: {CONVEX_URL: ''}})
    assert.equal(res.status, 503)
  })
})

describe('Stream', () => {
  it('creates a tus upload with the creator, 3 h limit and allowed origins', async () => {
    const res = await call('/videos/api/uploads', {method: 'POST', token: await tokenFor('user_writer'), body: {fileName: 'Episode 1.mov', size: 812_000_000}})
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), {uploadURL: `https://upload.cloudflarestream.com/tus/${UID}`, uid: UID})
    const {url, init} = streamCalls[0]
    assert.equal(url, 'https://api.cloudflare.com/client/v4/accounts/acct/stream?direct_user=true')
    assert.equal(init.headers['Upload-Length'], '812000000')
    assert.equal(init.headers['Upload-Creator'], 'user_writer')
    assert.equal(init.headers.Authorization, 'Bearer stream-token')
    const meta = Object.fromEntries(init.headers['Upload-Metadata'].split(',').map((p) => p.split(' ')).map(([k, v]) => [k, Buffer.from(v, 'base64').toString()]))
    assert.deepEqual(meta, {name: 'Episode 1.mov', maxDurationSeconds: '10800', allowedorigins: 'blog.kedaipal.com'})
  })
  it('refuses bad requests before calling Stream', async () => {
    const token = await tokenFor('user_writer')
    assert.equal((await call('/videos/api/uploads', {method: 'POST', token, body: {fileName: '', size: 1}})).status, 400)
    assert.equal((await call('/videos/api/uploads', {method: 'POST', token, body: {fileName: 'x', size: 31 * 1024 ** 3}})).status, 413)
    assert.equal((await call('/videos/api/uploads/status?uid=../../etc', {token})).status, 400)
    assert.equal(streamCalls.length, 0)
  })
  it('status hands back the link only in the shape the Video block accepts', async () => {
    const data = await (await call(`/videos/api/uploads/status?uid=${UID}`, {token: await tokenFor('user_superadmin')})).json()
    assert.equal(data.readyToStream, true)
    assert.equal(data.link, `https://customer-abc123.cloudflarestream.com/${UID}/iframe`)
    assert.equal(data.thumbnail, `https://customer-abc123.cloudflarestream.com/${UID}/thumbnails/thumbnail.jpg`)
    assert.equal(data.pctComplete, 100)
    assert.equal(data.duration, 2712.4)
  })
  it('recent marks the caller’s own uploads and pending ones', async () => {
    const data = await (await call('/videos/api/recent', {token: await tokenFor('user_writer')})).json()
    assert.equal(data.videos.length, 2)
    assert.equal(data.videos[0].mine, true)
    assert.equal(data.videos[1].mine, false)
    assert.equal(data.videos[1].ready, false)
    assert.equal(data.videos[1].duration, null)
  })
  it('without the token, uploads say Stream is off and recent is empty', async () => {
    const token = await tokenFor('user_writer')
    assert.equal((await call('/videos/api/uploads', {method: 'POST', token, body: {fileName: 'x', size: 1}, envOverride: {STREAM_API_TOKEN: ''}})).status, 503)
    assert.deepEqual(await (await call('/videos/api/recent', {token, envOverride: {STREAM_API_TOKEN: ''}})).json(), {streamConfigured: false, videos: []})
  })
})
