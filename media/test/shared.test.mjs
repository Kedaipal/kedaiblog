import assert from 'node:assert/strict'
import {describe, it} from 'node:test'
import {formatBytes, formatDuration, frontendApiFromKey, streamLink, streamThumbnail} from '../public/videos/lib/shared.js'
import {uploadMetadata} from '../src/stream.js'

// Verbatim from Kedaipal/kedaiblog#4 (js/sanity.js, parseVideoLink) — the link must pass it.
const VIDEO_STREAM_RE = /^(?:https:\/\/(customer-[a-z0-9]+)\.cloudflarestream\.com\/([0-9a-f]{32})\/(?:iframe|watch)\/?(?:\?[^\s#]*)?|([0-9a-f]{32}))$/

describe('the link contract with the Video block', () => {
  it('emits exactly the Stream iframe link the block parses', () => {
    const uid = '0123456789abcdef0123456789abcdef'
    const link = streamLink('abc123xyz', uid)
    assert.equal(link, `https://customer-abc123xyz.cloudflarestream.com/${uid}/iframe`)
    const m = VIDEO_STREAM_RE.exec(link)
    assert.ok(m)
    assert.equal(m[2], uid)
    assert.equal(streamThumbnail('abc123xyz', uid), `https://customer-abc123xyz.cloudflarestream.com/${uid}/thumbnails/thumbnail.jpg`)
  })
})

describe('frontendApiFromKey', () => {
  it('decodes the production and dev publishable keys', () => {
    assert.equal(frontendApiFromKey('pk_live_Y2xlcmsua2VkYWlwYWwuY29tJA'), 'clerk.kedaipal.com')
    assert.equal(frontendApiFromKey('pk_test_bGlrZWQtaW1wYWxhLTguY2xlcmsuYWNjb3VudHMuZGV2JA'), 'liked-impala-8.clerk.accounts.dev')
  })
  it('refuses anything else', () => {
    assert.equal(frontendApiFromKey(''), null)
    assert.equal(frontendApiFromKey('sk_live_abc'), null)
    assert.equal(frontendApiFromKey('pk_live_bm90LWEta2V5'), null) // no trailing $
  })
})

describe('Stream upload metadata', () => {
  const decode = (header) => Object.fromEntries(header.split(',').map((pair) => {
    const [k, v] = pair.split(' ')
    return [k, Buffer.from(v, 'base64').toString('utf8')]
  }))
  it('sets name, 3 h max duration and the allowed origins', () => {
    assert.deepEqual(decode(uploadMetadata({name: 'Episode 1 — Kris.mov', allowedOrigins: ['blog.kedaipal.com']})), {
      name: 'Episode 1 — Kris.mov',
      maxDurationSeconds: '10800',
      allowedorigins: 'blog.kedaipal.com',
    })
  })
  it('never asks for signed URLs (public blog)', () => {
    assert.doesNotMatch(uploadMetadata({name: 'x', allowedOrigins: ['blog.kedaipal.com']}), /requiresignedurls/)
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
