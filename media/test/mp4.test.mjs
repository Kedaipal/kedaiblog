import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {describe, it} from 'node:test'
import {fileURLToPath} from 'node:url'
import {PROBE_BYTES, containerOf, probeFastStart, walkBoxes} from '../public/videos/lib/mp4.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name) => readFileSync(join(here, 'fixtures', name))

const ascii = (s) => Buffer.from(s, 'latin1')
const u32 = (n) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}
const box = (type, payload = Buffer.alloc(0)) => Buffer.concat([u32(8 + payload.length), ascii(type), payload])

describe('probeFastStart on the committed fixtures', () => {
  it('faststart.mp4: moov before mdat → ok', () => {
    const r = probeFastStart(fixture('faststart.mp4'))
    assert.equal(r.fastStart, true)
    assert.deepEqual(r.order, ['ftyp', 'moov', 'mdat'])
  })
  it('not-faststart.mp4: mdat before moov → refused', () => {
    const r = probeFastStart(fixture('not-faststart.mp4'))
    assert.equal(r.fastStart, false)
    assert.equal(r.reason, 'mdat-first')
    assert.deepEqual(r.order, ['ftyp', 'mdat', 'moov'])
  })
  it('works on just the first 2 MB (what the browser reads)', () => {
    const head = fixture('faststart.mp4').subarray(0, PROBE_BYTES)
    assert.equal(probeFastStart(head).fastStart, true)
  })
})

describe('probeFastStart on awkward layouts', () => {
  it('tolerates a free box and a 64-bit "largesize" mdat that runs past the buffer', () => {
    const largeMdatHeader = Buffer.concat([u32(1), ascii('mdat'), u32(1), u32(0)]) // 4 GiB + 0, declared
    const buf = Buffer.concat([box('ftyp', ascii('isom')), box('free', Buffer.alloc(16)), largeMdatHeader, Buffer.alloc(64)])
    const r = probeFastStart(buf)
    assert.equal(r.fastStart, false)
    assert.deepEqual(r.order, ['ftyp', 'free', 'mdat'])
  })
  it('a moov that is not within the probed bytes counts as not fast-start', () => {
    const buf = Buffer.concat([box('ftyp', ascii('isom')), box('free', Buffer.alloc(PROBE_BYTES))]).subarray(0, PROBE_BYTES)
    const r = probeFastStart(buf)
    assert.equal(r.fastStart, false)
    assert.equal(r.reason, 'moov-not-found')
  })
  it('a size-0 ("to end of file") mdat is handled', () => {
    const buf = Buffer.concat([box('ftyp', ascii('isom')), box('moov'), u32(0), ascii('mdat'), Buffer.alloc(32)])
    assert.equal(probeFastStart(buf).fastStart, true)
    assert.equal(walkBoxes(buf).at(-1).size, Infinity)
  })
  it('garbage is not an MP4', () => {
    const r = probeFastStart(Buffer.from('this is not a video file at all, sorry'))
    assert.equal(r.fastStart, false)
  })
  it('does not loop forever on a corrupt box size', () => {
    const buf = Buffer.concat([box('ftyp', ascii('isom')), u32(3), ascii('xxxx')])
    assert.deepEqual(walkBoxes(buf).map((b) => b.type), ['ftyp'])
  })
})

describe('containerOf', () => {
  it('reads the ftyp major brand', () => {
    assert.equal(containerOf(fixture('faststart.mp4')), 'mp4')
    assert.equal(containerOf(Buffer.concat([box('ftyp', Buffer.concat([ascii('qt  '), u32(0)])), box('moov')])), 'mov')
    assert.equal(containerOf(Buffer.from('\x1aE\xdf\xa3 webm-ish', 'latin1')), 'none')
  })
})
