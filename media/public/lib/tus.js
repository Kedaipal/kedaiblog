/*
 * A minimal tus 1.0.0 client — just what a browser needs to push one file to
 * the resumable upload URL Cloudflare Stream hands out, with progress and
 * automatic resume after a dropped connection. ~100 lines we can read, rather
 * than a vendored 60 KB bundle.
 *
 * Protocol (https://tus.io/protocols/resumable-upload):
 *   HEAD  url                       → Upload-Offset: how much the server has
 *   PATCH url  Upload-Offset: <n>   → body = next bytes; response Upload-Offset
 *         Content-Type: application/offset+octet-stream
 * Every request carries Tus-Resumable: 1.0.0.
 *
 * Cloudflare Stream wants chunks that are a multiple of 256 KiB, at least
 * 5 MiB, and recommends 50 MiB. The last chunk may be smaller.
 */

export const TUS_CHUNK = 50 * 1024 * 1024

export class TusError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

function headOffset(url, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('HEAD', url)
    xhr.setRequestHeader('Tus-Resumable', '1.0.0')
    xhr.onload = () => {
      const offset = Number(xhr.getResponseHeader('Upload-Offset'))
      if (xhr.status >= 200 && xhr.status < 300 && Number.isFinite(offset)) resolve(offset)
      else reject(new TusError(`HEAD ${xhr.status}`, xhr.status))
    }
    xhr.onerror = () => reject(new TusError('network error on HEAD', 0))
    xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'))
    signal?.addEventListener('abort', () => xhr.abort(), {once: true})
    xhr.send()
  })
}

function patchChunk(url, offset, blob, {signal, onProgress}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PATCH', url)
    xhr.setRequestHeader('Tus-Resumable', '1.0.0')
    xhr.setRequestHeader('Upload-Offset', String(offset))
    xhr.setRequestHeader('Content-Type', 'application/offset+octet-stream')
    xhr.upload.onprogress = (e) => onProgress?.(offset + e.loaded)
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const next = Number(xhr.getResponseHeader('Upload-Offset'))
        resolve(Number.isFinite(next) ? next : offset + blob.size)
      } else reject(new TusError(`PATCH ${xhr.status}`, xhr.status))
    }
    xhr.onerror = () => reject(new TusError('network error on PATCH', 0))
    xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'))
    signal?.addEventListener('abort', () => xhr.abort(), {once: true})
    xhr.send(blob)
  })
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(new DOMException('aborted', 'AbortError'))), {once: true})
  })

/**
 * Upload `file` to `uploadUrl`. Resolves when the server has every byte.
 * @param {object} o
 * @param {Blob} o.file
 * @param {string} o.uploadUrl       the tus URL (Location) Stream returned
 * @param {number} [o.chunkSize]
 * @param {(sentBytes: number, attempt: number) => void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 * @param {number} [o.retries]       consecutive failures tolerated before giving up
 */
export async function tusUpload({file, uploadUrl, chunkSize = TUS_CHUNK, onProgress, signal, retries = 6}) {
  let offset = 0
  let failures = 0
  while (offset < file.size) {
    try {
      const chunk = file.slice(offset, Math.min(offset + chunkSize, file.size))
      offset = await patchChunk(uploadUrl, offset, chunk, {signal, onProgress: (sent) => onProgress?.(sent, failures)})
      failures = 0
    } catch (err) {
      if (err.name === 'AbortError') throw err
      // 4xx other than 409/423 means the request itself is wrong; no point retrying.
      if (err.status >= 400 && err.status < 500 && err.status !== 409 && err.status !== 423) throw err
      if (++failures > retries) throw new TusError(`gave up after ${retries} retries (${err.message})`, err.status)
      await sleep(Math.min(1000 * 2 ** (failures - 1), 15000), signal)
      // Ask the server where it actually is before sending more.
      try {
        offset = await headOffset(uploadUrl, signal)
      } catch (e) {
        if (e.name === 'AbortError') throw e
      }
    }
  }
  return offset
}
