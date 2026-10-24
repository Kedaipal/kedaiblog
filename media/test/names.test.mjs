import assert from 'node:assert/strict'
import {describe, it} from 'node:test'
import {
  NAME_MAX,
  R2_MAX_SECONDS,
  VIDEO_KEY_RE,
  POSTER_KEY_RE,
  clipLink,
  decideDestination,
  monthFolder,
  normaliseName,
  pickFreeName,
  posterKey,
  streamLink,
  streamThumbnail,
  videoKey,
} from '../public/lib/names.js'

describe('normaliseName', () => {
  it('lowercases, turns spaces into dashes, strips everything else, drops the extension', () => {
    assert.equal(normaliseName('My Clip.mp4'), 'my-clip')
    assert.equal(normaliseName('Kedaipal Demo (Final) v2.MOV'), 'kedaipal-demo-final-v2')
    assert.equal(normaliseName('Épisode 3 – intro.mp4'), 'pisode-3-intro')
    assert.equal(normaliseName('IMG_1234.mp4'), 'img-1234')
    assert.equal(normaliseName('  spaced   out  .mp4'), 'spaced-out')
  })
  it('only drops the LAST extension and keeps a leading dot-name', () => {
    assert.equal(normaliseName('clip.final.mp4'), 'clipfinal')
    assert.equal(normaliseName('.mp4'), 'mp4')
  })
  it('caps at 60 characters without a trailing dash', () => {
    const long = 'a'.repeat(59) + '-' + 'b'.repeat(20) + '.mp4'
    const out = normaliseName(long)
    assert.ok(out.length <= NAME_MAX)
    assert.equal(out, 'a'.repeat(59))
  })
  it('falls back to "video" when nothing survives', () => {
    assert.equal(normaliseName('???.mp4'), 'video')
    assert.equal(normaliseName(''), 'video')
    assert.equal(normaliseName(undefined), 'video')
  })
})

describe('pickFreeName', () => {
  const taken = (set) => async (name) => set.has(name)
  it('returns the name itself when free', async () => {
    assert.deepEqual(await pickFreeName('clip', taken(new Set())), {name: 'clip', suffixed: false})
  })
  it('suffixes -2, -3 … until free', async () => {
    assert.deepEqual(await pickFreeName('clip', taken(new Set(['clip']))), {name: 'clip-2', suffixed: true})
    assert.deepEqual(await pickFreeName('clip', taken(new Set(['clip', 'clip-2']))), {name: 'clip-3', suffixed: true})
    assert.deepEqual(await pickFreeName('clip', taken(new Set(['clip', 'clip-2', 'clip-3', 'clip-4']))), {name: 'clip-5', suffixed: true})
  })
  it('never exceeds 60 characters when suffixing', async () => {
    const base = 'x'.repeat(60)
    const {name} = await pickFreeName(base, taken(new Set([base])))
    assert.ok(name.length <= NAME_MAX)
    assert.ok(name.endsWith('-2'))
  })
  it('gives up after the limit instead of looping forever', async () => {
    await assert.rejects(pickFreeName('clip', async () => true, 5), /No free name/)
  })
})

describe('decideDestination — the routing rule', () => {
  it('299 s → R2, 300 s → R2, 301 s → Stream', () => {
    assert.equal(R2_MAX_SECONDS, 300)
    assert.equal(decideDestination(299), 'r2')
    assert.equal(decideDestination(300), 'r2')
    assert.equal(decideDestination(301), 'stream')
  })
  it('handles fractions right at the edge', () => {
    assert.equal(decideDestination(299.99), 'r2')
    assert.equal(decideDestination(300.01), 'stream')
  })
  it('refuses to route a duration it cannot trust', () => {
    assert.equal(decideDestination(NaN), 'unknown')
    assert.equal(decideDestination(Infinity), 'unknown')
    assert.equal(decideDestination(0), 'unknown')
    assert.equal(decideDestination(-5), 'unknown')
  })
})

describe('keys and links — the contract with the Video block', () => {
  it('builds dated keys', () => {
    assert.equal(videoKey('2026-10', 'my-clip'), 'videos/2026-10/my-clip.mp4')
    assert.equal(posterKey('2026-10', 'my-clip'), 'videos/2026-10/my-clip.jpg')
    assert.match(videoKey('2026-10', 'my-clip'), VIDEO_KEY_RE)
    assert.match(posterKey('2026-10', 'my-clip-2'), POSTER_KEY_RE)
  })
  it('only accepts keys it would have generated', () => {
    assert.doesNotMatch('videos/2026-10/../x.mp4', VIDEO_KEY_RE)
    assert.doesNotMatch('videos/2026-10/My Clip.mp4', VIDEO_KEY_RE)
    assert.doesNotMatch('other/2026-10/clip.mp4', VIDEO_KEY_RE)
    assert.doesNotMatch('videos/2026-10/clip.mp4', POSTER_KEY_RE)
  })
  it('monthFolder is yyyy-mm in Malaysian time', () => {
    // 31 Oct 2026 20:00 UTC is already 1 Nov 04:00 in Kuala Lumpur.
    assert.equal(monthFolder(new Date('2026-10-31T20:00:00Z')), '2026-11')
    assert.equal(monthFolder(new Date('2026-10-15T00:00:00Z')), '2026-10')
  })
  it('emits exactly the link shapes the Studio accepts', () => {
    assert.equal(clipLink('https://media.kedaipal.com', 'videos/2026-10/my-clip.mp4'), 'https://media.kedaipal.com/videos/2026-10/my-clip.mp4')
    assert.equal(clipLink('https://media.kedaipal.com/', 'videos/2026-10/my-clip.mp4'), 'https://media.kedaipal.com/videos/2026-10/my-clip.mp4')
    const uid = 'a'.repeat(32)
    assert.equal(streamLink('abc123', uid), `https://customer-abc123.cloudflarestream.com/${uid}/iframe`)
    assert.equal(streamThumbnail('abc123', uid), `https://customer-abc123.cloudflarestream.com/${uid}/thumbnails/thumbnail.jpg`)
  })
})
