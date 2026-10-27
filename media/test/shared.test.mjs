import assert from 'node:assert/strict'
import {describe, it} from 'node:test'
import {
  CLIP_MAX_SECONDS,
  NAME_MAX,
  POSTER_KEY_RE,
  VIDEO_KEY_RE,
  clipLink,
  decideDestination,
  formatBytes,
  formatDuration,
  frontendApiFromKey,
  monthFolder,
  normaliseName,
  pickFreeName,
  posterKey,
  videoKey,
} from '../public/videos/lib/shared.js'

// Verbatim from Kedaipal/kedaiblog#4 (js/sanity.js, parseVideoLink) — a clip link must pass it.
const VIDEO_FILE_RE = /^https:\/\/media\.kedaipal\.com\/videos\/([A-Za-z0-9_-]+)\/([A-Za-z0-9][A-Za-z0-9._-]*\.mp4)$/

describe('the routing rule', () => {
  it('299 s and 300 s are clips, 301 s goes to YouTube', () => {
    assert.equal(CLIP_MAX_SECONDS, 300)
    assert.equal(decideDestination(299), 'clip')
    assert.equal(decideDestination(300), 'clip')
    assert.equal(decideDestination(301), 'youtube')
    assert.equal(decideDestination(300.01), 'youtube')
    assert.equal(decideDestination(45 * 60), 'youtube')
  })
  it('a duration the browser could not read is "unknown"', () => {
    for (const d of [NaN, Infinity, 0, -1, undefined]) assert.equal(decideDestination(d), 'unknown')
  })
})

describe('normaliseName', () => {
  it('lowercases, dashes spaces, strips the rest, drops the extension', () => {
    assert.equal(normaliseName('My Clip.mp4'), 'my-clip')
    assert.equal(normaliseName('Kedaipal Demo (Final) v2.MP4'), 'kedaipal-demo-final-v2')
    assert.equal(normaliseName('IMG_1234.mp4'), 'img-1234')
    assert.equal(normaliseName('  spaced   out  .mp4'), 'spaced-out')
    assert.equal(normaliseName('Épisode 3 – intro.mp4'), 'pisode-3-intro')
  })
  it('caps at 60 without a trailing dash, and falls back to "video"', () => {
    assert.equal(normaliseName('a'.repeat(59) + '-' + 'b'.repeat(20) + '.mp4'), 'a'.repeat(59))
    assert.equal(normaliseName('???.mp4'), 'video')
    assert.equal(normaliseName(''), 'video')
  })
})

describe('pickFreeName — never overwrite', () => {
  const taken = (set) => async (n) => set.has(n)
  it('keeps a free name, then -2, -3 …', async () => {
    assert.deepEqual(await pickFreeName('clip', taken(new Set())), {name: 'clip', suffixed: false})
    assert.deepEqual(await pickFreeName('clip', taken(new Set(['clip']))), {name: 'clip-2', suffixed: true})
    assert.deepEqual(await pickFreeName('clip', taken(new Set(['clip', 'clip-2']))), {name: 'clip-3', suffixed: true})
  })
  it('stays within 60 characters and gives up rather than loop', async () => {
    const base = 'x'.repeat(NAME_MAX)
    const {name} = await pickFreeName(base, taken(new Set([base])))
    assert.ok(name.length <= NAME_MAX && name.endsWith('-2'))
    await assert.rejects(pickFreeName('clip', async () => true, 5), /No free name/)
  })
})

describe('keys and the clip link — the contract with the Video block', () => {
  it('builds dated keys the Worker will accept', () => {
    assert.equal(videoKey('2026-10', 'my-clip'), 'videos/2026-10/my-clip.mp4')
    assert.equal(posterKey('2026-10', 'my-clip'), 'videos/2026-10/my-clip.jpg')
    assert.match(videoKey('2026-10', 'my-clip-2'), VIDEO_KEY_RE)
    assert.match(posterKey('2026-10', 'my-clip'), POSTER_KEY_RE)
  })
  it('refuses keys it would never generate', () => {
    for (const k of ['videos/2026-10/../x.mp4', 'videos/2026-10/My Clip.mp4', 'other/2026-10/clip.mp4', 'videos/_test/smoke.mp4']) assert.doesNotMatch(k, VIDEO_KEY_RE)
  })
  it('monthFolder is Malaysian time', () => {
    assert.equal(monthFolder(new Date('2026-10-31T20:00:00Z')), '2026-11')
    assert.equal(monthFolder(new Date('2026-10-15T00:00:00Z')), '2026-10')
  })
  it('every generated link passes the Video block parser', async () => {
    for (const file of ['My Clip.mp4', '???.mp4', 'x'.repeat(80) + '.mp4', 'IMG_1234.MP4']) {
      const {name} = await pickFreeName(normaliseName(file), async (n) => n === normaliseName(file))
      const link = clipLink('https://media.kedaipal.com', videoKey('2026-10', name))
      assert.match(link, VIDEO_FILE_RE, link)
    }
    assert.equal(clipLink('https://media.kedaipal.com/', 'videos/2026-10/a.mp4'), 'https://media.kedaipal.com/videos/2026-10/a.mp4')
  })
})

describe('frontendApiFromKey', () => {
  it('decodes the production and dev publishable keys, refuses anything else', () => {
    assert.equal(frontendApiFromKey('pk_live_Y2xlcmsua2VkYWlwYWwuY29tJA'), 'clerk.kedaipal.com')
    assert.equal(frontendApiFromKey('pk_test_bGlrZWQtaW1wYWxhLTguY2xlcmsuYWNjb3VudHMuZGV2JA'), 'liked-impala-8.clerk.accounts.dev')
    for (const k of ['', 'offline', 'sk_live_abc', 'pk_live_bm90LWEta2V5']) assert.equal(frontendApiFromKey(k), null)
  })
})

describe('formatting', () => {
  it('formats durations and sizes', () => {
    assert.equal(formatDuration(34.4), '0:34')
    assert.equal(formatDuration(45 * 60 + 7), '45:07')
    assert.equal(formatDuration(3 * 3600 + 5), '3:00:05')
    assert.equal(formatDuration(null), '—')
    assert.equal(formatBytes(1506372), '1.4 MB')
    assert.equal(formatBytes(2.5 * 1024 ** 3), '2.5 GB')
  })
})
