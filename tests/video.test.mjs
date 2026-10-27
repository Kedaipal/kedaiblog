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

  test('YouTube: every accepted shape resolves to the 11-character id', () => {
    const ID = 'M7lc1UVf-VE'
    for (const link of [
      `https://www.youtube.com/watch?v=${ID}`,
      `https://www.youtube.com/watch?v=${ID}&t=42s`,
      `https://www.youtube.com/watch?feature=share&list=PL123&v=${ID}`,
      `https://youtube.com/watch?v=${ID}`,
      `https://m.youtube.com/watch?v=${ID}`,
      `https://youtu.be/${ID}`,
      `https://youtu.be/${ID}?si=abc123`,
      `https://www.youtube.com/live/${ID}`,
      `https://www.youtube.com/embed/${ID}`,
      `https://www.youtube-nocookie.com/embed/${ID}?start=10`,
    ]) {
      assert.deepEqual(plain(parseVideoLink(link)), {kind: 'youtube', id: ID, short: false, poster: `https://i.ytimg.com/vi/${ID}/hqdefault.jpg`}, link)
    }
    assert.deepEqual(plain(parseVideoLink(`https://www.youtube.com/shorts/${ID}`)), {kind: 'youtube', id: ID, short: true, poster: `https://i.ytimg.com/vi/${ID}/hqdefault.jpg`})
  })

  test('YouTube: lookalikes, other hosts and non-video pages are rejected', () => {
    for (const bad of [
      'http://www.youtube.com/watch?v=M7lc1UVf-VE',
      'https://www.youtube.com/watch?v=M7lc1UVf-VEx', // 12 characters
      'https://www.youtube.com/watch?v=M7lc1UVf-V', // 10 characters
      'https://www.youtube.com.evil.com/watch?v=M7lc1UVf-VE',
      'https://evil.com/?u=https://youtu.be/M7lc1UVf-VE',
      'https://music.youtube.com/watch?v=M7lc1UVf-VE',
      'https://www.youtube.com/@kedaipal',
      'https://www.youtube.com/playlist?list=PL1234567890',
      'https://youtube-nocookie.com/embed/M7lc1UVf-VE', // no www
    ]) {
      assert.equal(parseVideoLink(bad), null, `should reject: ${bad}`)
    }
  })

  test('YouTube: playlists are refused; a single video from a playlist is accepted', () => {
    assert.equal(parseVideoLink('https://www.youtube.com/embed/videoseries?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG'), null)
    assert.equal(parseVideoLink('https://www.youtube-nocookie.com/embed/videoseries?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG'), null)
    assert.equal(parseVideoLink('https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG'), null)
    assert.equal(parseVideoLink('https://www.youtube.com/watch?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG'), null)
    const v = parseVideoLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG&index=2')
    assert.deepEqual(plain(v), {kind: 'youtube', id: 'dQw4w9WgXcQ', short: false, poster: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'})
    assert.doesNotMatch(load().videoPlayer({link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG'}), /list=|PLx0s/, 'the playlist never reaches the page')
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

  test('aspect: the video sets the frame (block aspect, else 16:9); a poster never does', () => {
    const square = {asset: {url: 'https://cdn.sanity.io/images/opzqnhfl/production/sq-1000x1000.jpg', metadata: {dimensions: {width: 1000, height: 1000}}}}
    assert.match(render({link: CLIP, aspect: '16/9', poster: square}), /--aspect: 16 \/ 9"/, 'square poster on a 16:9 clip')
    assert.match(render({link: CLIP, aspect: '9/16', poster: square}), /--aspect: 9 \/ 16"/, 'square poster on a vertical clip')
    assert.match(render({link: CLIP, aspect: '9/16'}), /class="video video--file video--portrait" style="--aspect: 9 \/ 16"/)
    assert.doesNotMatch(render({link: CLIP, aspect: '4/3'}), /video--portrait/)
    assert.match(render({link: CLIP, aspect: ' 4 / 3 '}), /--aspect: 4 \/ 3/)
    assert.match(render({link: CLIP}), /--aspect: 16 \/ 9/)
    assert.match(render({link: CLIP, aspect: '16/0'}), /--aspect: 16 \/ 9/, 'zero height falls back')
    assert.match(render({link: CLIP, aspect: '16/9; background: url(x)'}), /--aspect: 16 \/ 9"/, 'garbage never reaches the style attribute')
  })

  test('poster override: cut to the frame\'s shape so it covers it, edge to edge', () => {
    const square = {asset: {url: 'https://cdn.sanity.io/images/opzqnhfl/production/sq-1000x1000.jpg', metadata: {dimensions: {width: 1000, height: 1000}}}}
    assert.match(render({link: CLIP, aspect: '16/9', poster: square}), /poster="https:\/\/cdn\.sanity\.io\/images\/opzqnhfl\/production\/sq-1000x1000\.jpg\?w=1344&amp;h=756&amp;fit=crop&amp;auto=format&amp;q=80"/)
    assert.match(render({link: CLIP, aspect: '9/16', poster: square}), /sq-1000x1000\.jpg\?w=756&amp;h=1344&amp;fit=crop/)
    const stream = render({link: UID, poster: square})
    assert.match(stream, /iframe\?preload=metadata&amp;poster=https%3A%2F%2Fcdn\.sanity\.io%2Fimages%2Fopzqnhfl%2Fproduction%2Fsq-1000x1000\.jpg%3Fw%3D1344%26h%3D756/)
    assert.doesNotMatch(render({link: CLIP, poster: {asset: null}}), /cdn\.sanity\.io/, 'a poster with no asset is ignored')
  })

  test('poster override: the Studio\'s crop and hotspot are honoured', () => {
    const cropped = {
      crop: {left: 0.25, right: 0.25, top: 0, bottom: 0},
      hotspot: {x: 0.6, y: 0.4, width: 0.2, height: 0.2},
      asset: {url: 'https://cdn.sanity.io/images/opzqnhfl/production/wide-1600x900.jpg', metadata: {dimensions: {width: 1600, height: 900}}},
    }
    assert.match(render({link: CLIP, aspect: '16/9', poster: cropped}),
      /wide-1600x900\.jpg\?rect=400%2C0%2C800%2C900&amp;w=1344&amp;h=756&amp;fit=crop&amp;crop=focalpoint&amp;fp-x=0\.700&amp;fp-y=0\.400&amp;auto=format&amp;q=80"/)
  })

  test('caption: text under the player, newlines kept, escaped', () => {
    const html = render({link: CLIP, title: 'A <b>title</b>', caption: 'Line one\nLine "two"'})
    assert.match(html, /<figcaption><strong>A &lt;b&gt;title&lt;\/b&gt;<\/strong> Line one<br \/>Line &quot;two&quot;<\/figcaption>/)
  })

  test('YouTube: a click-to-load button, nothing from youtube.com in the page until play', () => {
    const html = render({link: 'https://youtu.be/M7lc1UVf-VE?si=x', title: 'Episode 1'})
    assert.match(html, /<figure class="video video--youtube" style="--aspect: 16 \/ 9">/)
    assert.match(html, /<button class="video-facade" type="button" data-yt="M7lc1UVf-VE" data-title="Episode 1" aria-label="Play: Episode 1">/)
    assert.match(html, /<img src="https:\/\/i\.ytimg\.com\/vi\/M7lc1UVf-VE\/maxresdefault\.jpg" data-fallback="https:\/\/i\.ytimg\.com\/vi\/M7lc1UVf-VE\/hqdefault\.jpg" alt="" loading="lazy"/)
    assert.doesNotMatch(html, /youtube\.com|youtube-nocookie|<iframe/, 'no YouTube embed before the click')
    assert.match(render({link: 'https://youtu.be/M7lc1UVf-VE'}), /aria-label="Play: video"/)
  })

  test('YouTube: a Short gets a 9:16 box; a poster override is cut to the frame', () => {
    assert.match(render({link: 'https://www.youtube.com/shorts/M7lc1UVf-VE'}), /class="video video--youtube video--portrait" style="--aspect: 9 \/ 16"/)
    assert.match(render({link: 'https://www.youtube.com/shorts/M7lc1UVf-VE', aspect: '9/16'}), /--aspect: 9 \/ 16/)
    const square = {asset: {url: 'https://cdn.sanity.io/images/opzqnhfl/production/sq-1000x1000.jpg', metadata: {dimensions: {width: 1000, height: 1000}}}}
    const html = render({link: 'https://youtu.be/M7lc1UVf-VE', poster: square})
    assert.match(html, /style="--aspect: 16 \/ 9"/, 'square poster on a YouTube video keeps the 16:9 frame')
    assert.match(html, /<img src="https:\/\/cdn\.sanity\.io\/images\/opzqnhfl\/production\/sq-1000x1000\.jpg\?w=1344&amp;h=756&amp;fit=crop/)
    assert.doesNotMatch(html, /data-fallback|ytimg/, 'an override poster needs no YouTube thumbnail')
  })

  test('YouTube: the embed URL is rebuilt from the id only, never the stored link', () => {
    const {youtubeEmbedSrc} = load()
    assert.equal(youtubeEmbedSrc('M7lc1UVf-VE'), 'https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?autoplay=1&rel=0&playsinline=1')
    assert.equal(youtubeEmbedSrc('M7lc1UVf-VE"><x'), null)
    assert.equal(youtubeEmbedSrc(''), null)
    // The regex allows any tail after the id; the markup only ever carries the id
    const html = render({link: 'https://www.youtube.com/watch?v=M7lc1UVf-VE&x="><script>alert(1)</script>'})
    assert.doesNotMatch(html, /<script>|alert/)
    assert.match(html, /data-yt="M7lc1UVf-VE"/)
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
  test('the regexes are byte-for-byte identical in js/sanity.js and VideoLinkInput.jsx', () => {
    for (const name of ['VIDEO_FILE_RE', 'VIDEO_YOUTUBE_RE', 'VIDEO_STREAM_RE']) {
      assert.equal(pick(STUDIO_INPUT, name), pick(SANITY_JS, name), name)
    }
  })
  test('both parsers refuse the videoseries playlist embed the same way', () => {
    const rule = "m[1] !== 'videoseries'"
    assert.ok(SANITY_JS.includes(rule), 'js/sanity.js')
    assert.ok(STUDIO_INPUT.includes(rule), 'VideoLinkInput.jsx')
  })

  test('the Studio tells a playlist apart from any other refused link', () => {
    assert.match(STUDIO_INPUT, /"That's a playlist\. Paste the link of a single video from it\."/)
    const re = new Function('return ' + STUDIO_INPUT.match(/const YOUTUBE_PLAYLIST_RE = (\/.*\/)\n/)[1])()
    for (const link of [
      'https://www.youtube.com/embed/videoseries?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG',
      'https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG',
      'https://m.youtube.com/watch?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG',
    ]) assert.ok(re.test(link), link)
    for (const link of ['https://example.com/?list=PL1', 'https://www.youtube.com/@kedaipal']) assert.ok(!re.test(link), link)
  })

  test('the Studio message points to the admin page and the YouTube channel', () => {
    assert.match(STUDIO_INPUT, /That's not a link we can play\. Upload a clip at admin\.kedaipal\.com\/videos, or paste the link of a video on our YouTube channel\./)
  })
})
