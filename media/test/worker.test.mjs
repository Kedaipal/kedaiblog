/*
 * The Worker end to end with the network stubbed (Clerk's JWKS, Convex's query
 * API, YouTube oEmbed) and an in-memory R2 bucket.
 */
import assert from 'node:assert/strict'
import {after, before, beforeEach, describe, it} from 'node:test'
import worker from '../src/worker.js'
import {clearAccessCache} from '../src/access.js'
import {monthFolder, PART_SIZE} from '../public/videos/lib/shared.js'
import {FakeR2} from './fake-r2.mjs'
import {ADMIN_ORIGIN, ISSUER, makeKey, signToken} from './helpers.mjs'

const CONVEX = 'https://dev-deployment.convex.cloud'
const AREAS = {user_writer: ['videos'], user_seller: []}
const MONTH = monthFolder()

let key, realFetch, bucket, convexDown, oembedStatus
const env = () => ({
  CLERK_PUBLISHABLE_KEY: 'pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk',
  CLERK_ISSUER: ISSUER,
  CLERK_AUTHORIZED_PARTIES: ADMIN_ORIGIN,
  CONVEX_URL: CONVEX,
  PUBLIC_MEDIA_BASE: 'https://media.kedaipal.com',
  MEDIA: bucket,
  ASSETS: {fetch: async (req) => new Response(`asset:${new URL(req.url).pathname}`, {headers: {'content-type': 'text/html'}})},
})

before(async () => {
  key = await makeKey('ins_1')
  realFetch = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input)
    if (url === `${ISSUER}/.well-known/jwks.json`) return Response.json({keys: [key.jwk]})
    if (url === `${CONVEX}/api/query`) {
      if (convexDown) return Response.json({status: 'error', errorMessage: 'boom'}, {status: 500})
      const sub = JSON.parse(Buffer.from(init.headers.authorization.slice(7).split('.')[1], 'base64url')).sub
      return Response.json({status: 'success', value: {areas: AREAS[sub] ?? []}})
    }
    if (url.startsWith('https://www.youtube.com/oembed')) {
      return oembedStatus === 200 ? Response.json({title: 'Kedaipal Podcast #1', author_name: 'Kedaipal'}) : new Response('Unauthorized', {status: oembedStatus})
    }
    throw new Error(`unexpected fetch ${url}`)
  }
})
after(() => (globalThis.fetch = realFetch))
beforeEach(() => {
  bucket = new FakeR2()
  convexDown = false
  oembedStatus = 200
  clearAccessCache()
})

const tokenFor = (sub, claims = {}) => signToken(key, {now: Math.floor(Date.now() / 1000), claims: {sub, ...claims}})
async function call(path, {method = 'GET', token, json, body, headers = {}, envOverride} = {}) {
  const init = {method, headers: {...headers}}
  if (token) init.headers.Authorization = `Bearer ${token}`
  if (json) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(json)
  } else if (body) {
    init.body = body
    init.headers['content-length'] = String(body.byteLength)
  }
  return worker.fetch(new Request(`https://admin.kedaipal.com${path}`, init), {...env(), ...envOverride})
}

/** Upload `bytes` as `fileName` through create → parts → complete; returns {created, completed}. */
async function uploadClip(token, fileName, bytes) {
  const created = await (await call('/videos/api/r2/create', {method: 'POST', token, json: {fileName, size: bytes.byteLength, duration: 34.4, width: 1280, height: 720}})).json()
  const parts = []
  for (let n = 1, off = 0; off < bytes.byteLength; n++, off += created.partSize) {
    const q = `key=${encodeURIComponent(created.key)}&uploadId=${created.uploadId}&n=${n}`
    parts.push(await (await call(`/videos/api/r2/part?${q}`, {method: 'PUT', token, body: bytes.subarray(off, off + created.partSize)})).json())
  }
  const res = await call('/videos/api/r2/complete', {method: 'POST', token, json: {key: created.key, uploadId: created.uploadId, parts}})
  return {created, res, completed: await res.json()}
}

describe('pages', () => {
  it('/ redirects to /videos; the shell serves /videos, /videos/recent, /videos/sign-in uncached', async () => {
    const r = await call('/')
    assert.equal(r.status, 302)
    assert.equal(r.headers.get('location'), 'https://admin.kedaipal.com/videos')
    for (const p of ['/videos', '/videos/', '/videos/recent', '/videos/sign-in']) {
      const res = await call(p)
      assert.equal(await res.text(), 'asset:/videos/index.html', p)
      assert.equal(res.headers.get('cache-control'), 'no-store')
    }
  })
  it('config.js carries public values only, and never an offline token on a real issuer', async () => {
    const text = await (await call('/videos/config.js', {envOverride: {DEV_OFFLINE_TOKEN: 'leak-me'}})).text()
    assert.match(text, /clerkPublishableKey/)
    assert.doesNotMatch(text, /leak-me/)
    const offline = await (await call('/videos/config.js', {envOverride: {DEV_OFFLINE_TOKEN: 'tok', CLERK_ISSUER: 'http://localhost:8790'}})).text()
    assert.match(offline, /"offline":\{"token":"tok"/)
  })
  it('the dev media route only exists with SERVE_MEDIA=1', async () => {
    bucket.put(`videos/${MONTH}/a.mp4`, new Uint8Array([1, 2, 3]), {httpMetadata: {contentType: 'video/mp4'}})
    assert.equal((await call(`/videos/dev-media/videos/${MONTH}/a.mp4`)).status, 404)
  })
  it('anything outside /videos is a 404', async () => {
    assert.equal((await call('/wp-admin')).status, 404)
  })
})

describe('the gate', () => {
  it('401 without a token, or with one minted for another origin', async () => {
    assert.equal((await call('/videos/api/me')).status, 401)
    assert.equal((await call('/videos/api/me', {token: await tokenFor('user_writer', {azp: 'https://kedaipal.com'})})).status, 401)
  })
  it('/api/me tells a seller they are not allowed; every other endpoint is 403 and touches nothing', async () => {
    const token = await tokenFor('user_seller')
    assert.deepEqual(await (await call('/videos/api/me', {token})).json(), {userId: 'user_seller', areas: [], allowed: false})
    assert.equal((await call('/videos/api/r2/create', {method: 'POST', token, json: {fileName: 'x.mp4', size: 10}})).status, 403)
    assert.equal((await call('/videos/api/youtube?url=https://youtu.be/dQw4w9WgXcQ', {token})).status, 403)
    assert.equal((await call('/videos/api/recent', {token})).status, 403)
    assert.equal(bucket.uploads.size + bucket.objects.size, 0)
  })
  it('a Convex failure is 503, never a pass', async () => {
    convexDown = true
    const res = await call('/videos/api/r2/create', {method: 'POST', token: await tokenFor('user_writer'), json: {fileName: 'x.mp4', size: 10}})
    assert.equal(res.status, 503)
    assert.equal(bucket.uploads.size, 0)
  })
  it('503 when deployed without its vars', async () => {
    assert.equal((await call('/videos/api/me', {token: await tokenFor('user_writer'), envOverride: {PUBLIC_MEDIA_BASE: ''}})).status, 503)
  })
})

describe('clips on R2', () => {
  it('multipart upload in 10 MB parts → one immutable object and the link the Video block takes', async () => {
    const token = await tokenFor('user_writer')
    const bytes = new Uint8Array(PART_SIZE * 2 + 1234).map((_, i) => i % 251)
    const {created, res, completed} = await uploadClip(token, 'Kedaipal Demo (Final).mp4', bytes)
    assert.equal(res.status, 200)
    assert.equal(created.key, `videos/${MONTH}/kedaipal-demo-final.mp4`)
    assert.equal(completed.url, `https://media.kedaipal.com/videos/${MONTH}/kedaipal-demo-final.mp4`)
    const stored = await bucket.get(created.key)
    assert.equal(stored.size, bytes.byteLength)
    assert.deepEqual(stored.body, bytes)
    assert.equal(stored.httpMetadata.contentType, 'video/mp4')
    assert.equal(stored.httpMetadata.cacheControl, 'public, max-age=31536000, immutable')
    assert.equal(stored.customMetadata.uploadedBy, 'user_writer')
    assert.equal(stored.customMetadata.duration, '34.4')
  })
  it('the same name twice becomes -2, then -3; nothing is overwritten', async () => {
    const token = await tokenFor('user_writer')
    const a = await uploadClip(token, 'clip.mp4', new Uint8Array([1]))
    const b = await uploadClip(token, 'clip.mp4', new Uint8Array([2]))
    const c = await uploadClip(token, 'Clip.mp4', new Uint8Array([3]))
    assert.deepEqual([a.created.name, b.created.name, c.created.name], ['clip', 'clip-2', 'clip-3'])
    assert.deepEqual([b.created.suffixed, b.created.wantedName], [true, 'clip'])
    assert.deepEqual((await bucket.get(`videos/${MONTH}/clip.mp4`)).body, new Uint8Array([1]))
  })
  it('complete refuses — and aborts — if the key appeared while uploading', async () => {
    const token = await tokenFor('user_writer')
    const created = await (await call('/videos/api/r2/create', {method: 'POST', token, json: {fileName: 'race.mp4', size: 1}})).json()
    const part = await (await call(`/videos/api/r2/part?key=${encodeURIComponent(created.key)}&uploadId=${created.uploadId}&n=1`, {method: 'PUT', token, body: new Uint8Array([9])})).json()
    await bucket.put(created.key, new Uint8Array([7])) // someone else got there first
    const res = await call('/videos/api/r2/complete', {method: 'POST', token, json: {key: created.key, uploadId: created.uploadId, parts: [part]}})
    assert.equal(res.status, 409)
    assert.deepEqual((await bucket.get(created.key)).body, new Uint8Array([7]))
    assert.equal(bucket.uploads.size, 0)
  })
  it('refuses keys it never issued, oversized parts and files over 2 GB', async () => {
    const token = await tokenFor('user_writer')
    assert.equal((await call('/videos/api/r2/part?key=videos/2026-10/../x.mp4&uploadId=u&n=1', {method: 'PUT', token, body: new Uint8Array([1])})).status, 400)
    assert.equal((await call(`/videos/api/r2/part?key=videos/${MONTH}/a.mp4&uploadId=u&n=1`, {method: 'PUT', token, body: new Uint8Array(PART_SIZE + 2048)})).status, 413)
    assert.equal((await call('/videos/api/r2/create', {method: 'POST', token, json: {fileName: 'big.mp4', size: 3 * 1024 ** 3}})).status, 413)
  })
  it('a poster goes beside its clip, once, and never on its own', async () => {
    const token = await tokenFor('user_writer')
    const {created} = await uploadClip(token, 'with-poster.mp4', new Uint8Array([1, 2]))
    const jpg = new Uint8Array([0xff, 0xd8, 0xff])
    const ok = await call(`/videos/api/r2/poster?key=${encodeURIComponent(created.posterKey)}`, {method: 'PUT', token, body: jpg})
    assert.equal(ok.status, 200)
    assert.equal((await bucket.head(created.posterKey)).httpMetadata.contentType, 'image/jpeg')
    assert.equal((await call(`/videos/api/r2/poster?key=${encodeURIComponent(created.posterKey)}`, {method: 'PUT', token, body: jpg})).status, 409)
    assert.equal((await call(`/videos/api/r2/poster?key=videos/${MONTH}/orphan.jpg`, {method: 'PUT', token, body: jpg})).status, 409)
  })
  it('abort discards the parts', async () => {
    const token = await tokenFor('user_writer')
    const created = await (await call('/videos/api/r2/create', {method: 'POST', token, json: {fileName: 'gone.mp4', size: 1}})).json()
    assert.equal(bucket.uploads.size, 1)
    assert.equal((await call('/videos/api/r2/abort', {method: 'POST', token, json: {key: created.key, uploadId: created.uploadId}})).status, 200)
    assert.equal(bucket.uploads.size, 0)
    assert.equal(await bucket.head(created.key), null)
  })
  it('recent lists our clips newest first with their posters, and skips the smoke file', async () => {
    const token = await tokenFor('user_writer')
    await bucket.put('videos/_test/smoke.mp4', new Uint8Array([1]))
    await uploadClip(token, 'first.mp4', new Uint8Array([1]))
    const {created} = await uploadClip(token, 'second.mp4', new Uint8Array([1, 2]))
    await call(`/videos/api/r2/poster?key=${encodeURIComponent(created.posterKey)}`, {method: 'PUT', token, body: new Uint8Array([0xff])})
    const {clips} = await (await call('/videos/api/recent', {token})).json()
    assert.deepEqual(clips.map((c) => c.name), [`${MONTH}/second`, `${MONTH}/first`])
    assert.equal(clips[0].poster, `https://media.kedaipal.com/videos/${MONTH}/second.jpg`)
    assert.equal(clips[1].poster, null)
    assert.equal(clips[0].duration, 34.4)
  })
})

describe('YouTube link check', () => {
  const ask = async (link) => (await call(`/videos/api/youtube?url=${encodeURIComponent(link)}`, {token: await tokenFor('user_writer')})).json()
  it('ok → title, channel and the canonical link', async () => {
    const res = await ask('https://youtu.be/dQw4w9WgXcQ?si=abc')
    assert.equal(res.status, 'ok')
    assert.equal(res.video.link, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    assert.equal(res.video.title, 'Kedaipal Podcast #1')
  })
  it('embedding off / private, not found, not YouTube', async () => {
    oembedStatus = 401
    assert.equal((await ask('https://youtu.be/dQw4w9WgXcQ')).status, 'not-embeddable')
    oembedStatus = 404
    assert.equal((await ask('https://youtu.be/dQw4w9WgXcQ')).status, 'not-found')
    assert.equal((await ask('https://vimeo.com/1')).status, 'not-youtube')
  })
})
