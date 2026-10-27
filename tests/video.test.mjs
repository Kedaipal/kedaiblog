// Run with: npm test   (Node's built-in runner; no dependencies)
import {test, describe} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'

const here = (p) => new URL(p, import.meta.url)
const SANITY_JS = readFileSync(here('../js/sanity.js'), 'utf8')
const STUDIO_INPUT = readFileSync(here('../studio/schemaTypes/VideoLinkInput.jsx'), 'utf8')

// js/sanity.js is a browser script that attaches itself to window.Blog
function load({streamCode = 'f33zs165nr7gyfy4'} = {}) {
  const window = {
    SANITY_CONFIG: {projectId: 'cvycqoxz', dataset: 'production', apiVersion: '2025-02-19'},
    STREAM_CUSTOMER_CODE: streamCode,
  }
  const warnings = []
  const ctx = vm.createContext({window, URL, console: {...console, warn: (m) => warnings.push(m)}})
  vm.runInContext(SANITY_JS, ctx)
  return {...window.Blog, warnings}
}

// Objects made inside the vm context have their own Object prototype; compare plain copies
const plain = (o) => JSON.parse(JSON.stringify(o))

const CLIP = 'https://media.kedaipal.com/videos/2026-10/sue-kitchen-tour.mp4'
const UID = '6b9e68b07dfee8cc2d116e4c51d6a957'
const STREAM = `https://customer-abc123xyz.cloudflarestream.com/${UID}/iframe`

describe('parseVideoLink', () => {
  const {parseVideoLink} = load()

  test('clip on media.kedaipal.com → file, poster beside it as .jpg', () => {
    assert.deepEqual(plain(parseVideoLink(CLIP)), {
      kind: 'file',
      src: CLIP,
      poster: 'https://media.kedaipal.com/videos/2026-10/sue-kitchen-tour.jpg',
      name: 'sue-kitchen-tour.mp4',
    })
  })

  test('clip: the smoke file folder and auto-suffixed names are accepted', () => {
    assert.equal(parseVideoLink('https://media.kedaipal.com/videos/_test/smoke.mp4')?.kind, 'file')
    assert.equal(parseVideoLink('https://media.kedaipal.com/videos/2026-10/Sue_Kitchen.tour-2.mp4')?.kind, 'file')
    assert.equal(parseVideoLink(`  ${CLIP}\n`)?.kind, 'file', 'surrounding whitespace is trimmed')
  })

  test('Stream: the three accepted forms all resolve to the same uid', () => {
    const expected = {
      kind: 'stream',
      uid: UID,
      src: `https://customer-f33zs165nr7gyfy4.cloudflarestream.com/${UID}/iframe?preload=metadata`,
      poster: `https://customer-f33zs165nr7gyfy4.cloudflarestream.com/${UID}/thumbnails/thumbnail.jpg`,
    }
    assert.deepEqual(plain(parseVideoLink(STREAM)), expected)
    assert.deepEqual(plain(parseVideoLink(`https://customer-abc123xyz.cloudflarestream.com/${UID}/watch`)), expected)
    assert.deepEqual(plain(parseVideoLink(UID)), expected)
    assert.deepEqual(plain(parseVideoLink(`${STREAM}/`)), expected, 'trailing slash')
    assert.deepEqual(plain(parseVideoLink(`${STREAM}?poster=x&preload=metadata`)), expected, 'dashboard embed query string')
  })

  test('Stream: the player URL comes from STREAM_CUSTOMER_CODE, never from the pasted link', () => {
    const v = load({streamCode: 'realcode'}).parseVideoLink(STREAM)
    assert.match(v.src, /^https:\/\/customer-realcode\.cloudflarestream\.com\//)
    assert.doesNotMatch(v.src, /abc123xyz/)
  })

  test('Stream without a customer code configured: recognised, but no player URL', () => {
    assert.deepEqual(plain(load({streamCode: ''}).parseVideoLink(UID)), {kind: 'stream', uid: UID, src: null, poster: null})
  })

  test('everything else is rejected', () => {
    for (const bad of [
      '',
      null,
      undefined,
      'https://example.com/x.mp4',
      'https://cdn.sanity.io/files/cvycqoxz/production/abc.mp4',
      'http://media.kedaipal.com/videos/2026-10/x.mp4', // not https
      'https://media.kedaipal.com/videos/2026-10/x.mov', // not mp4
      'https://media.kedaipal.com/videos/2026-10/x.MP4', // the upload page normalises to lower case
      'https://media.kedaipal.com/videos/x.mp4', // no folder
      'https://media.kedaipal.com/videos/2026-10/a/b.mp4', // nested
      'https://media.kedaipal.com/videos/2026-10/.hidden.mp4',
      'https://media.kedaipal.com/videos/2026-10/x.mp4?dl=1',
      'https://media.kedaipal.com.evil.com/videos/2026-10/x.mp4',
      'https://evil.com/https://media.kedaipal.com/videos/2026-10/x.mp4',
      `https://customer-abc.cloudflarestream.com/${UID}`, // no /iframe or /watch
      `https://customer-abc.cloudflarestream.com/${UID}/manifest/video.m3u8`,
      `https://videodelivery.net/${UID}/iframe`,
      `https://customer-abc.cloudflarestream.com/${UID.slice(1)}/iframe`, // 31 hex
      UID.toUpperCase(),
      `${UID}/iframe`,
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      `javascript:alert(1)//${UID}`,
      `${CLIP}" onmouseover="alert(1)`,
    ]) {
      assert.equal(load().parseVideoLink(bad), null, `should reject: ${bad}`)
    }
  })
})

describe('videoPlayer', () => {
  const {videoPlayer, portableText, warnings} = load()
  const render = (b) => videoPlayer({_type: 'video', ...b})

  test('clip: <video> with controls, inline playback, metadata preload, poster; no autoplay/muted/loop', () => {
    const html = render({link: CLIP, aspect: '16/9'})
    assert.match(html, /<figure class="video video--file" style="--aspect: 16 \/ 9">/)
    assert.match(html, /<div class="video-frame"><video controls playsinline preload="metadata" src="https:\/\/media\.kedaipal\.com\/videos\/2026-10\/sue-kitchen-tour\.mp4" poster="https:\/\/media\.kedaipal\.com\/videos\/2026-10\/sue-kitchen-tour\.jpg"><\/video><\/div>/)
    for (const attr of ['autoplay', 'muted', 'loop']) assert.doesNotMatch(html, new RegExp(`\\b${attr}\\b`))
    assert.doesNotMatch(html, /<figcaption/)
  })

  test('Stream: iframe rebuilt from uid + config, preload=metadata, allow list, allowfullscreen', () => {
    const html = render({link: STREAM, title: 'Episode 4'})
    assert.match(html, /class="video video--stream" style="--aspect: 16 \/ 9"/)
    assert.match(html, new RegExp(`<iframe src="https://customer-f33zs165nr7gyfy4\\.cloudflarestream\\.com/${UID}/iframe\\?preload=metadata" title="Episode 4" loading="lazy" allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`))
    assert.doesNotMatch(html, /abc123xyz/, 'customer code from the stored link is never used')
    assert.match(html, /<figcaption><strong>Episode 4<\/strong><\/figcaption>/)
  })

  test('aspect: poster override dims win, then the block aspect, then 16/9', () => {
    assert.match(render({link: CLIP, aspect: '9/16', posterDims: {width: 1200, height: 900}}), /--aspect: 1200 \/ 900/)
    assert.match(render({link: CLIP, aspect: '9/16'}), /class="video video--file video--portrait" style="--aspect: 9 \/ 16"/)
    assert.doesNotMatch(render({link: CLIP, aspect: '4/3'}), /video--portrait/)
    assert.match(render({link: CLIP, aspect: ' 4 / 3 '}), /--aspect: 4 \/ 3/)
    assert.match(render({link: CLIP}), /--aspect: 16 \/ 9/)
    assert.match(render({link: CLIP, aspect: '16/0'}), /--aspect: 16 \/ 9/, 'zero height falls back')
    assert.match(render({link: CLIP, aspect: '16/9; background: url(x)'}), /--aspect: 16 \/ 9"/, 'garbage never reaches the style attribute')
  })

  test('poster override: a Sanity CDN URL replaces the automatic poster', () => {
    const poster = 'https://cdn.sanity.io/images/cvycqoxz/production/abc-1600x900.jpg'
    const clip = render({link: CLIP, poster, posterDims: {width: 1600, height: 900}})
    assert.match(clip, /poster="https:\/\/cdn\.sanity\.io\/images\/cvycqoxz\/production\/abc-1600x900\.jpg\?w=1344&amp;auto=format&amp;q=80"/)
    const stream = render({link: UID, poster})
    assert.match(stream, /iframe\?preload=metadata&amp;poster=https%3A%2F%2Fcdn\.sanity\.io/)
  })

  test('caption: text under the player, newlines kept, escaped', () => {
    const html = render({link: CLIP, title: 'A <b>title</b>', caption: 'Line one\nLine "two"'})
    assert.match(html, /<figcaption><strong>A &lt;b&gt;title&lt;\/b&gt;<\/strong> Line one<br \/>Line &quot;two&quot;<\/figcaption>/)
  })

  test('every attribute goes through esc: a hostile link can never break out of the markup', () => {
    // These never parse, so they render nothing at all…
    assert.equal(render({link: `${CLIP}" onmouseover="alert(1)`}), '')
    assert.equal(render({link: `<script>${UID}`}), '')
    // …and a title with quotes or tags is inert
    const html = render({link: CLIP, title: `"><script>alert(1)</script>`})
    assert.doesNotMatch(html, /<script>/)
    assert.match(html, /title="&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/)
  })

  test('unknown link shapes render nothing, and the rest of the article is untouched', () => {
    const blocks = [
      {_type: 'block', _key: 'a', style: 'normal', children: [{_type: 'span', text: 'Before'}]},
      {_type: 'video', _key: 'b', link: 'https://example.com/x.mp4'},
      {_type: 'video', _key: 'c'},
      {_type: 'video', _key: 'd', link: CLIP},
      {_type: 'block', _key: 'e', style: 'normal', children: [{_type: 'span', text: 'After'}]},
    ]
    const html = portableText(blocks)
    assert.equal(html.match(/<figure class="video/g).length, 1)
    assert.doesNotMatch(html, /example\.com/)
    assert.match(html, /<p>Before<\/p>\s*<figure class="video video--file"[\s\S]*<\/figure>\s*<p>After<\/p>/)
  })

  test('Stream with no STREAM_CUSTOMER_CODE configured is skipped with a warning, clips still play', () => {
    const blog = load({streamCode: ''})
    assert.equal(blog.videoPlayer({link: STREAM}), '')
    assert.equal(blog.warnings.length, 1)
    assert.match(blog.warnings[0], /STREAM_CUSTOMER_CODE/)
    assert.match(blog.videoPlayer({link: CLIP}), /<video /)
  })
  void warnings
})

describe('Studio input mirrors the site parser', () => {
  const pick = (src, name) => {
    const m = src.match(new RegExp(`const ${name} = (/.*/);`))
    assert.ok(m, `${name} not found`)
    return m[1]
  }
  test('both regexes are byte-for-byte identical in js/sanity.js and VideoLinkInput.jsx', () => {
    for (const name of ['VIDEO_FILE_RE', 'VIDEO_STREAM_RE']) {
      assert.equal(pick(STUDIO_INPUT, name), pick(SANITY_JS, name), name)
    }
  })
  test('the Studio message names admin.kedaipal.com/videos', () => {
    assert.match(STUDIO_INPUT, /That's not a link from admin\.kedaipal\.com\/videos\. Upload the video there first, then paste the link it gives you\./)
  })
})
