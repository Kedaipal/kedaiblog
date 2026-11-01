#!/usr/bin/env node
/*
 * Writes the two MP4 fixtures used by test/mp4.test.mjs:
 *   test/fixtures/faststart.mp4      ftyp · moov · mdat   (plays progressively)
 *   test/fixtures/not-faststart.mp4  ftyp · mdat · moov   (must download fully first)
 *
 * They are built byte by byte here — no ffmpeg needed, and the output is
 * identical on every machine — because the fast-start probe only reads the
 * top-level box headers. The boxes are structurally valid (sizes, types, an
 * mvhd inside moov) but carry no real video, so a player will not show a
 * picture; that is fine for a probe fixture and keeps each file at ~40 KB.
 *
 * If you ever want real, playable fixtures instead, with ffmpeg installed:
 *   ffmpeg -f lavfi -i testsrc=size=160x90:rate=10 -t 1 -pix_fmt yuv420p \
 *          -movflags +faststart test/fixtures/faststart.mp4
 *   ffmpeg -f lavfi -i testsrc=size=160x90:rate=10 -t 1 -pix_fmt yuv420p \
 *          test/fixtures/not-faststart.mp4
 * (ffmpeg writes moov last unless +faststart is given.)
 */
import {mkdirSync, writeFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..', 'test', 'fixtures')

const ascii = (s) => Buffer.from(s, 'latin1')
const u32 = (n) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}
const box = (type, ...payload) => {
  const body = Buffer.concat(payload)
  return Buffer.concat([u32(8 + body.length), ascii(type), body])
}

const ftyp = box('ftyp', ascii('isom'), u32(0x200), ascii('isom'), ascii('iso2'), ascii('avc1'), ascii('mp41'))

// A minimal-but-real mvhd (version 0): timescale 1000, duration 1000 ms.
const mvhd = box(
  'mvhd',
  u32(0), // version + flags
  u32(0), // creation time
  u32(0), // modification time
  u32(1000), // timescale
  u32(1000), // duration
  u32(0x00010000), // rate 1.0
  Buffer.from([0x01, 0x00]), // volume 1.0
  Buffer.alloc(10), // reserved
  Buffer.concat([0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].map(u32)), // unity matrix
  Buffer.alloc(24), // pre_defined
  u32(2), // next track id
)
const moov = box('moov', mvhd)

// A deterministic pseudo-random payload so the file is not all zeros.
const mdatBytes = Buffer.alloc(40 * 1024)
let seed = 0x9e3779b9
for (let i = 0; i < mdatBytes.length; i++) {
  seed = (seed * 1664525 + 1013904223) >>> 0
  mdatBytes[i] = seed >>> 24
}
const mdat = box('mdat', mdatBytes)

mkdirSync(out, {recursive: true})
writeFileSync(join(out, 'faststart.mp4'), Buffer.concat([ftyp, moov, mdat]))
writeFileSync(join(out, 'not-faststart.mp4'), Buffer.concat([ftyp, mdat, moov]))
console.log(`wrote ${out}/faststart.mp4 and not-faststart.mp4`)
