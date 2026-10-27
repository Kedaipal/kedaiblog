import assert from 'node:assert/strict'
import {describe, it} from 'node:test'
import {VIDEO_YOUTUBE_RE, parseYouTubeLink} from '../public/videos/lib/youtube.js'
import {checkYouTubeLink} from '../src/youtube.js'

// The exact source shared with the Video block (ClickUp z8r3fdwwpp, Kedaipal/kedaiblog#4).
// If this line fails, the two copies have drifted — fix both, never just this one.
const SHARED_SOURCE = String.raw`^https:\/\/(?:(?:www\.|m\.)?youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/|www\.youtube-nocookie\.com\/embed\/)([A-Za-z0-9_-]{11})(?=$|[?&#/])\S*$`

const ID = 'dQw4w9WgXcQ'

describe('VIDEO_YOUTUBE_RE', () => {
  it('is byte-for-byte the regex the Video block uses', () => {
    assert.equal(VIDEO_YOUTUBE_RE.source, SHARED_SOURCE)
  })
  it('accepts every link shape YouTube hands out', () => {
    for (const link of [
      `https://www.youtube.com/watch?v=${ID}`,
      `https://youtube.com/watch?v=${ID}&t=42s`,
      `https://www.youtube.com/watch?feature=share&v=${ID}`,
      `https://m.youtube.com/watch?v=${ID}`,
      `https://youtu.be/${ID}?si=abc123`,
      `https://www.youtube.com/shorts/${ID}?feature=share`,
      `https://www.youtube.com/live/${ID}?si=x`,
      `https://www.youtube.com/embed/${ID}`,
      `https://www.youtube-nocookie.com/embed/${ID}?rel=0`,
      `https://www.youtube.com/watch?v=${ID}&list=PL123`,
    ]) assert.equal(parseYouTubeLink(link)?.id, ID, link)
  })
  it('refuses lookalikes, wrong ids and non-video pages', () => {
    for (const link of [
      `http://www.youtube.com/watch?v=${ID}`,
      `https://www.youtube.com/watch?v=${ID}X`,
      'https://www.youtube.com/watch?v=short',
      `https://evil.com/?u=https://youtu.be/${ID}`,
      `https://youtube.com.evil.com/watch?v=${ID}`,
      `https://www.youtube.com/watch?vv=${ID}`,
      'https://www.youtube.com/channel/UCxyz',
      'https://www.youtube.com/playlist?list=PL1',
      `https://media.kedaipal.com/videos/2026-10/${ID}.mp4`,
      '',
    ]) assert.equal(parseYouTubeLink(link), null, link)
  })
})

describe('parseYouTubeLink', () => {
  it('hands out the canonical watch link and the thumbnail, and spots Shorts', () => {
    assert.deepEqual(parseYouTubeLink(`  https://youtu.be/${ID}?si=x  `), {
      id: ID,
      short: false,
      canonical: `https://www.youtube.com/watch?v=${ID}`,
      thumbnail: `https://i.ytimg.com/vi/${ID}/hqdefault.jpg`,
    })
    assert.equal(parseYouTubeLink(`https://www.youtube.com/shorts/${ID}`).short, true)
  })
  it('the canonical link it emits is itself accepted', () => {
    assert.match(parseYouTubeLink(`https://youtu.be/${ID}`).canonical, VIDEO_YOUTUBE_RE)
  })
})

describe('checkYouTubeLink — can the blog embed it? (YouTube oEmbed)', () => {
  const stub = (status, body) => {
    const calls = []
    return {calls, fetchImpl: async (url) => (calls.push(url), new Response(body ? JSON.stringify(body) : 'x', {status}))}
  }
  it('ok: asks oEmbed about the canonical link and returns title + channel', async () => {
    const {calls, fetchImpl} = stub(200, {title: 'Kedaipal Podcast #1', author_name: 'Kedaipal'})
    const res = await checkYouTubeLink(`https://youtu.be/${ID}?si=x`, {fetchImpl})
    assert.equal(calls[0], `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${ID}`)}&format=json`)
    assert.equal(res.status, 'ok')
    assert.equal(res.video.link, `https://www.youtube.com/watch?v=${ID}`)
    assert.equal(res.video.title, 'Kedaipal Podcast #1')
    assert.equal(res.video.channel, 'Kedaipal')
  })
  it('401 → embedding off or private; 404 → not found; 5xx or network → unreachable', async () => {
    assert.equal((await checkYouTubeLink(`https://youtu.be/${ID}`, stub(401))).status, 'not-embeddable')
    assert.equal((await checkYouTubeLink(`https://youtu.be/${ID}`, stub(404))).status, 'not-found')
    assert.equal((await checkYouTubeLink(`https://youtu.be/${ID}`, stub(503))).status, 'unreachable')
    const down = {fetchImpl: async () => {
      throw new TypeError('fetch failed')
    }}
    assert.equal((await checkYouTubeLink(`https://youtu.be/${ID}`, down)).status, 'unreachable')
  })
  it('never calls YouTube for something that is not a YouTube link', async () => {
    const {calls, fetchImpl} = stub(200, {})
    assert.equal((await checkYouTubeLink('https://vimeo.com/123', {fetchImpl})).status, 'not-youtube')
    assert.equal(calls.length, 0)
  })
})
