/*
 * Fast-start probe for MP4/MOV files — browser and Worker/Node alike.
 *
 * An MP4 is a sequence of boxes: [size:4][type:4][payload]. The `moov` box
 * holds the index the player needs before it can start; `mdat` holds the
 * media. If `mdat` comes first, a browser has to download the whole file
 * before it can play, so a clip served straight from R2 would appear broken.
 * HandBrake's "Web Optimized" / ffmpeg's `-movflags +faststart` move `moov` to
 * the front.
 *
 * The page reads only the first 2 MB (PROBE_BYTES); that is plenty for every
 * sane faststart file (moov is usually under a few hundred KB) and keeps the
 * check instant on a 2 GB file.
 */

export const PROBE_BYTES = 2 * 1024 * 1024

const BOX_HEADER = 8

function typeAt(view, offset) {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  )
}

/**
 * Walk the top-level boxes in `bytes` (an ArrayBuffer or Uint8Array holding the
 * START of the file). Returns the boxes seen, in order, with their offsets and
 * declared sizes. Stops at the first box whose header does not fit, or whose
 * declared size runs past the buffer (that box is still reported — we know
 * its type from the header — but nothing after it).
 */
export function walkBoxes(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const boxes = []
  let offset = 0
  while (offset + BOX_HEADER <= buf.byteLength) {
    let size = view.getUint32(offset)
    const type = typeAt(view, offset + 4)
    let headerSize = BOX_HEADER
    if (size === 1) {
      // 64-bit "largesize" follows the type.
      if (offset + 16 > buf.byteLength) break
      const hi = view.getUint32(offset + 8)
      const lo = view.getUint32(offset + 12)
      size = hi * 2 ** 32 + lo
      headerSize = 16
    } else if (size === 0) {
      // "to end of file" — only legal for the last box.
      size = Infinity
    }
    if (size < headerSize) break // corrupt; stop rather than loop forever
    boxes.push({type, offset, size, truncated: offset + size > buf.byteLength})
    if (offset + size > buf.byteLength) break
    offset += size
  }
  return boxes
}

/**
 * Container sniff from the `ftyp` box's major brand.
 *   "mp4"  — ISO base media (isom, iso2, mp41, mp42, avc1, M4V …)
 *   "mov"  — QuickTime (major brand "qt  ")
 *   "none" — no ftyp box at the start: not an MP4-family file at all
 */
export function containerOf(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const boxes = walkBoxes(buf)
  const ftyp = boxes[0]
  if (!ftyp || ftyp.type !== 'ftyp' || ftyp.offset + 12 > buf.byteLength) return 'none'
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const brand = typeAt(view, ftyp.offset + 8)
  return brand === 'qt  ' ? 'mov' : 'mp4'
}

/**
 * Is `moov` before `mdat`?
 * Returns {fastStart, order, reason}. `order` is the top-level box types
 * seen, for display/debugging.
 *   fastStart: true    moov seen before any mdat
 *   fastStart: false   mdat seen first ("mdat-first"), or neither found in the
 *                      probed bytes ("moov-not-found" — a moov that far in
 *                      would stall playback just the same)
 */
export function probeFastStart(bytes) {
  const boxes = walkBoxes(bytes)
  const order = boxes.map((b) => b.type)
  for (const box of boxes) {
    if (box.type === 'moov') return {fastStart: true, order, reason: 'moov-first'}
    if (box.type === 'mdat') return {fastStart: false, order, reason: 'mdat-first'}
  }
  return {fastStart: false, order, reason: boxes.length ? 'moov-not-found' : 'not-mp4'}
}
