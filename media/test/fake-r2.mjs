/*
 * An in-memory R2 bucket with the slice of the binding the Worker uses: head,
 * get, put, list, createMultipartUpload / resumeMultipartUpload (uploadPart,
 * complete, abort). Enough to drive the Worker end to end in `node --test`;
 * `npm run dev` / `dev:offline` exercise wrangler's real local simulator.
 */
export class FakeR2 {
  constructor() {
    this.objects = new Map() // key -> {body: Uint8Array, httpMetadata, customMetadata, uploaded}
    this.uploads = new Map() // uploadId -> {key, opts, parts: Map<n, Uint8Array>}
    this.seq = 0
  }
  #meta(key) {
    const o = this.objects.get(key)
    if (!o) return null
    return {key, size: o.body.byteLength, httpMetadata: o.httpMetadata, customMetadata: o.customMetadata, uploaded: o.uploaded, httpEtag: `"${key}"`}
  }
  async head(key) {
    return this.#meta(key)
  }
  async get(key) {
    const m = this.#meta(key)
    return m && {...m, body: this.objects.get(key).body}
  }
  async put(key, value, opts = {}) {
    this.objects.set(key, {body: new Uint8Array(value), httpMetadata: opts.httpMetadata, customMetadata: opts.customMetadata, uploaded: new Date(Date.now() + this.seq++)})
    return this.#meta(key)
  }
  async list({prefix = '', include} = {}) {
    const objects = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).map((k) => {
      const m = this.#meta(k)
      if (!include?.includes('customMetadata')) delete m.customMetadata
      return m
    })
    return {objects, truncated: false}
  }
  async createMultipartUpload(key, opts) {
    const uploadId = `up-${++this.seq}`
    this.uploads.set(uploadId, {key, opts, parts: new Map()})
    return {uploadId, key}
  }
  resumeMultipartUpload(key, uploadId) {
    const bucket = this
    const get = () => {
      const u = bucket.uploads.get(uploadId)
      if (!u || u.key !== key) throw new Error('NoSuchUpload')
      return u
    }
    return {
      async uploadPart(n, body) {
        get().parts.set(n, new Uint8Array(body))
        return {partNumber: n, etag: `etag-${uploadId}-${n}`}
      },
      async complete(parts) {
        const u = get()
        const chunks = parts.sort((a, b) => a.partNumber - b.partNumber).map((p) => {
          if (p.etag !== `etag-${uploadId}-${p.partNumber}`) throw new Error('InvalidPart')
          return u.parts.get(p.partNumber)
        })
        const body = new Uint8Array(chunks.reduce((s, c) => s + c.byteLength, 0))
        let off = 0
        for (const c of chunks) body.set(c, (off += c.byteLength) - c.byteLength)
        bucket.uploads.delete(uploadId)
        return bucket.put(key, body, u.opts)
      },
      async abort() {
        bucket.uploads.delete(uploadId)
      },
    }
  }
}
