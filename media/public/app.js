/*
 * The upload page. One file at a time, through these states (ClickUp z8r3fdx50u):
 *
 *   idle → reading → decision ─┬→ uploading (R2)      → done
 *                              ├→ uploading (Stream)  → processing → done
 *                              └→ refused
 *   any upload state → error (after retries) / cancelled → back to decision
 *
 * All the policy (≤ 5 min → R2, > 5 min → Stream, MP4-only + fast-start for R2,
 * poster at 2 s or 10 %, never overwrite) is applied here, in the browser, where
 * the file is — and re-checked by the Worker where it matters (keys, sizes).
 */
import {containerOf, probeFastStart, PROBE_BYTES} from './lib/mp4.js'
import {R2_MAX_BYTES, R2_MAX_SECONDS, decideDestination, formatBytes, formatDuration, monthFolder, normaliseName, videoKey} from './lib/names.js'
import {tusUpload} from './lib/tus.js'
import {copyText, el, toast} from './lib/ui.js'

/* ---------- copy: the exact words from the ticket ---------- */

const MSG = {
  decode:
    "This file won't play in browsers. Export it as <strong>MP4 (H.264 video, AAC audio)</strong> — in HandBrake: preset <em>Fast 720p30</em> (or 1080p30), tick <em>Web Optimized</em>.",
  fastStart:
    'This MP4 would only start playing after it has fully downloaded. Re-export with <strong>Web Optimized / fast start</strong> on (HandBrake: Summary → Web Optimized).',
  mov: 'Short clips are stored as MP4. Export this as MP4 (see above) — or use <em>Send to Stream anyway</em> if you can\'t re-export.',
  movHint: 'MP4 means H.264 video + AAC audio — in HandBrake: preset <em>Fast 720p30</em> (or 1080p30), tick <em>Web Optimized</em>.',
  tooLarge: 'Too large for a clip this length — export at 1080p or 720p.',
  rule: 'Clips up to 5 minutes are stored on our own domain for free. Longer videos go to Cloudflare Stream, which plays smoothly on any connection and is billed per minute watched.',
  whyR2: 'Under 5 minutes, so it is stored on our own domain and costs nothing to play.',
  whyStream: 'Over 5 minutes, so it goes to Cloudflare Stream: smooth playback on any connection, billed per minute watched.',
  whyOverride: 'You chose Stream for this clip: smooth playback on poor connections, billed per minute watched.',
  overrideCost: 'For a short clip that must play smoothly on bad connections. Stream bills about US$5 per 1,000 minutes stored each month, plus US$1 per 1,000 minutes watched.',
  processing: 'Processing on Cloudflare (a few minutes)…',
  gaveUp: 'The upload failed after several retries. Check your connection and try again — nothing was saved.',
  expired: 'Your sign-in has expired. Reload the page to sign in again — the file is still on your computer.',
  streamOff: 'Stream is not connected to this page yet, so long videos cannot be uploaded. Ask Zaki.',
}

const ICON = {
  file: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m10 9 5 3-5 3z" fill="currentColor" stroke="none"/></svg>',
  copy: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
  warn: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
  info: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
  check: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5L20 7"/></svg>',
}

/* ---------- DOM ---------- */

const $drop = document.getElementById('drop')
const $file = document.getElementById('file')
const $panel = document.getElementById('panel')
const $who = document.getElementById('who')

let me = {email: '', streamConfigured: false, publicMediaBase: 'https://media.kedaipal.com', localDev: false}
let current = null // {file, objectUrl, meta, poster, container, probe, decision, controller}

/* ---------- API ---------- */

class ApiError extends Error {
  constructor(status, message, body) {
    super(message)
    this.status = status
    this.body = body
  }
}

async function api(method, path, body, {signal} = {}) {
  const res = await fetch(path, {
    method,
    signal,
    headers: body ? {'content-type': 'application/json'} : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  let data = null
  try {
    data = await res.json()
  } catch {
    /* non-JSON — fall through */
  }
  if (!res.ok) throw new ApiError(res.status, res.status === 401 ? MSG.expired : data?.message || `Request failed (${res.status})`, data)
  return data
}

/** PUT raw bytes with upload progress, via XHR (fetch has no upload progress). */
function putBytes(path, blob, {signal, onProgress} = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', path)
    xhr.setRequestHeader('content-type', 'application/octet-stream')
    xhr.upload.onprogress = (e) => onProgress?.(e.loaded)
    xhr.onload = () => {
      let data = null
      try {
        data = JSON.parse(xhr.responseText)
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data)
      else reject(new ApiError(xhr.status, xhr.status === 401 ? MSG.expired : data?.message || `Upload failed (${xhr.status})`, data))
    }
    xhr.onerror = () => reject(new ApiError(0, 'network error'))
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

/* ---------- file analysis ---------- */

function readMetadata(file, objectUrl) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.muted = true
    video.playsInline = true
    const done = (fn) => {
      clearTimeout(timer)
      video.onloadedmetadata = video.onerror = null
      fn()
    }
    const timer = setTimeout(() => done(() => reject(new Error('decode'))), 30000)
    video.onloadedmetadata = () =>
      done(() => {
        const {duration, videoWidth, videoHeight} = video
        if (!Number.isFinite(duration) || duration <= 0 || !videoWidth || !videoHeight) reject(new Error('decode'))
        else resolve({video, duration, width: videoWidth, height: videoHeight})
      })
    video.onerror = () => done(() => reject(new Error('decode')))
    video.src = objectUrl
  })
}

/** Seek to 2 s (or 10 % of the duration if that is shorter), draw to a canvas, JPEG 0.85, ≤ 1280 wide. */
function capturePoster(video, duration) {
  return new Promise((resolve, reject) => {
    const t = Math.min(2, duration * 0.1)
    const timer = setTimeout(() => reject(new Error('decode')), 20000)
    const draw = () => {
      clearTimeout(timer)
      try {
        const scale = Math.min(1, 1280 / video.videoWidth)
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(video.videoWidth * scale)
        canvas.height = Math.round(video.videoHeight * scale)
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
        canvas.toBlob((blob) => (blob ? resolve({blob, width: canvas.width, height: canvas.height}) : reject(new Error('decode'))), 'image/jpeg', 0.85)
      } catch {
        reject(new Error('decode'))
      }
    }
    video.onseeked = () => {
      video.onseeked = null
      // The seeked frame is decoded by now; a short timeout (not rAF, which
      // pauses in a background tab) lets the decoder hand it to the canvas.
      setTimeout(draw, 30)
    }
    video.onerror = () => (clearTimeout(timer), reject(new Error('decode')))
    video.currentTime = t
  })
}

async function probeFile(file) {
  const head = await file.slice(0, PROBE_BYTES).arrayBuffer()
  return {container: containerOf(head), probe: probeFastStart(head)}
}

/* ---------- rendering ---------- */

function fileStrip(file) {
  return el(
    'div',
    {class: 'file-strip'},
    el('span', {class: 'file-icon', html: ICON.file}),
    el('span', {class: 'file-name', title: file.name, text: file.name}),
    el('span', {class: 'file-size', text: formatBytes(file.size)}),
    el('button', {class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => resetToIdle()}, 'Choose another'),
  )
}

function notice(kind, html, extraHtml) {
  const icon = kind === 'error' ? ICON.warn : kind === 'warn' ? ICON.info : kind === 'ok' ? ICON.check : ICON.info
  return el(
    'div',
    {class: `notice notice--${kind}`, role: kind === 'error' ? 'alert' : null},
    el('span', {html: icon}),
    el('div', {}, el('p', {html}), extraHtml ? el('p', {class: 'small', html: extraHtml}) : null),
  )
}

function render(...children) {
  $panel.replaceChildren(fileStrip(current.file), el('div', {class: 'panel-body'}, ...children))
  $panel.hidden = false
  $drop.hidden = true
}

function facts(items) {
  const list = el('ul', {class: 'facts'})
  items.filter(Boolean).forEach(([label, value]) => list.append(el('li', {}, `${label} `, el('strong', {text: value}))))
  return list
}

function thumb() {
  const box = el('div', {class: 'route-thumb'})
  if (current.posterUrl) box.append(el('img', {src: current.posterUrl, alt: 'Poster frame'}))
  else box.append('No preview')
  return box
}

/* ----- states ----- */

function showReading(step) {
  render(
    el(
      'div',
      {class: 'status'},
      el('span', {class: 'spinner', 'aria-hidden': 'true'}),
      el('div', {}, el('div', {class: 'status-text', text: step}), el('div', {class: 'status-sub', text: 'Nothing is uploaded until you confirm.'})),
    ),
  )
}

function showDecision() {
  const {meta, file, decision, name} = current
  const toR2 = decision === 'r2'
  const month = monthFolder()
  const title = toR2
    ? el('div', {class: 'route-title'}, 'Clip', el('span', {class: 'arrow', text: '→'}), 'R2', el('span', {class: 'pill', text: 'free'}))
    : el('div', {class: 'route-title'}, 'Long video', el('span', {class: 'arrow', text: '→'}), 'Stream', el('span', {class: 'pill pill--amber', text: 'per minute'}))
  const why = el('p', {class: 'route-why', text: toR2 ? MSG.whyR2 : MSG.whyStream})

  const dest = toR2
    ? el('p', {class: 'dest'}, 'Will be saved as ', el('code', {text: videoKey(month, name)}), ' (if that name is taken, it becomes ', el('code', {text: `${name}-2`}), ')')
    : el('p', {class: 'dest'}, 'Stream will transcode it and give it an id; the link comes back when it is ready.')

  const actions = el('div', {class: 'actions'})
  if (toR2) {
    actions.append(
      el('button', {class: 'btn btn-accent', type: 'button', onclick: () => startR2()}, 'Upload to R2'),
      el('button', {class: 'btn btn-outline', type: 'button', disabled: !me.streamConfigured, onclick: () => startStream(true)}, 'Send to Stream anyway'),
      el('p', {class: 'hint', text: me.streamConfigured ? MSG.overrideCost : MSG.streamOff}),
    )
  } else {
    actions.append(el('button', {class: 'btn btn-accent', type: 'button', disabled: !me.streamConfigured, onclick: () => startStream(false)}, 'Upload to Stream'))
    if (!me.streamConfigured) actions.append(el('p', {class: 'hint', text: MSG.streamOff}))
  }

  render(
    el(
      'div',
      {class: 'route'},
      thumb(),
      el(
        'div',
        {},
        title,
        why,
        facts([
          ['Duration', formatDuration(meta.duration)],
          ['Size', formatBytes(file.size)],
          ['Frame', `${meta.width} × ${meta.height}`],
        ]),
        dest,
      ),
    ),
    actions,
  )
}

/**
 * Refused: the exact message, the file stays selected, and — when the refusal
 * is about the R2 path only — the Stream override is still on the table.
 */
function showRefused(reason) {
  const {meta, file} = current
  const body = []
  if (reason === 'decode') {
    body.push(el('p', {class: 'refused-title', text: "Can't use this file"}), notice('error', MSG.decode))
  } else if (reason === 'fastStart') {
    body.push(el('p', {class: 'refused-title', text: 'Not a fast-start MP4'}), notice('error', MSG.fastStart))
  } else if (reason === 'mov') {
    body.push(el('p', {class: 'refused-title', text: 'MOV files are not stored as clips'}), notice('error', MSG.mov, MSG.movHint))
  } else if (reason === 'tooLarge') {
    body.push(el('p', {class: 'refused-title', text: 'Too large for the clip path'}), notice('error', MSG.tooLarge))
  }
  if (meta) {
    body.push(facts([['Duration', formatDuration(meta.duration)], ['Size', formatBytes(file.size)], ['Frame', `${meta.width} × ${meta.height}`]]))
  }
  const actions = el('div', {class: 'actions'}, el('button', {class: 'btn btn-primary', type: 'button', onclick: () => resetToIdle()}, 'Pick another file'))
  if (reason !== 'decode' && current.decision === 'r2') {
    actions.append(
      el('button', {class: 'btn btn-outline', type: 'button', disabled: !me.streamConfigured, onclick: () => startStream(true)}, 'Send to Stream anyway'),
      el('p', {class: 'hint', text: me.streamConfigured ? MSG.overrideCost : MSG.streamOff}),
    )
  }
  body.push(actions)
  render(...body)
}

function progressBlock({indeterminate = false} = {}) {
  const fill = el('span')
  const bar = el('div', {class: `bar${indeterminate ? ' is-indeterminate' : ''}`, role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100'}, fill)
  const left = el('span')
  const right = el('span')
  const wrap = el('div', {class: 'progress'}, bar, el('div', {class: 'progress-meta'}, left, right))
  return {
    wrap,
    set(pct, leftText, rightText) {
      if (pct != null) {
        fill.style.width = `${pct}%`
        bar.setAttribute('aria-valuenow', String(Math.round(pct)))
      }
      left.innerHTML = leftText
      right.textContent = rightText
    },
  }
}

function showUploading({label, sub, suffixNote, onCancel, indeterminate = false}) {
  const p = progressBlock({indeterminate})
  const extras = []
  if (suffixNote) extras.push(suffixNote)
  render(
    el(
      'div',
      {class: 'status'},
      el('span', {class: 'spinner', 'aria-hidden': 'true'}),
      el('div', {}, el('div', {class: 'status-text', text: label}), el('div', {class: 'status-sub', text: sub})),
    ),
    p.wrap,
    ...extras.map((n) => Object.assign(n, {style: 'margin-top:1rem'})),
    el('div', {class: 'actions'}, el('button', {class: 'btn btn-outline', type: 'button', onclick: onCancel}, 'Cancel')),
  )
  return p
}

function showError(message, {retry} = {}) {
  const actions = el('div', {class: 'actions'})
  if (retry) actions.append(el('button', {class: 'btn btn-accent', type: 'button', onclick: retry}, 'Try again'))
  actions.append(el('button', {class: 'btn btn-outline', type: 'button', onclick: () => showDecision()}, 'Back'))
  render(el('p', {class: 'refused-title', text: 'Upload failed'}), notice('error', message), actions)
}

function suffixNotice(result) {
  if (!result.suffixed) return null
  return notice('warn', `Saved as <code>${result.name}</code> — <code>${result.wantedName}</code> was already taken, and nothing is ever overwritten.`)
}

function showDone({kind, link, posterUrl, duration, size, suffixNote}) {
  const code = el('code', {text: link})
  const copyBtn = el(
    'button',
    {
      class: 'btn btn-primary btn-sm',
      type: 'button',
      html: `${ICON.copy}<span>Copy</span>`,
      onclick: async () => toast((await copyText(link)) ? 'Link copied' : 'Could not copy — select the link and copy it by hand'),
    },
  )
  const preview = el('div', {class: 'preview'})
  if (kind === 'r2') {
    preview.append(el('video', {controls: true, playsinline: true, preload: 'metadata', poster: posterUrl || null, src: link}))
  } else if (posterUrl) {
    preview.append(el('img', {src: posterUrl, alt: 'Stream thumbnail', onerror: (e) => e.target.remove()}))
  }
  render(
    notice('ok', kind === 'r2' ? 'Uploaded. The clip is live on media.kedaipal.com.' : 'Ready. Cloudflare Stream has finished processing the video.'),
    suffixNote ? Object.assign(suffixNote, {style: 'margin-top:1rem'}) : null,
    el('p', {class: 'result-label', style: 'margin-top:1.5rem', text: 'Your link'}),
    el('div', {class: 'linkbox'}, code, copyBtn),
    el('p', {class: 'paste-hint', html: 'Paste this into the Studio\'s <strong>Video</strong> block (+ → Video).'}),
    preview,
    facts([
      ['Duration', formatDuration(duration)],
      ['Size', formatBytes(size)],
      [kind === 'r2' ? 'Poster' : 'Thumbnail', kind === 'r2' ? 'captured automatically, same name .jpg' : "Stream's own, picked automatically"],
    ]),
    el('div', {class: 'actions'}, el('button', {class: 'btn btn-outline', type: 'button', onclick: () => resetToIdle()}, 'Upload another')),
  )
  copyBtn.focus()
}

/* ---------- flows ---------- */

function resetToIdle() {
  if (current?.controller) current.controller.abort()
  if (current?.objectUrl) URL.revokeObjectURL(current.objectUrl)
  if (current?.posterUrl) URL.revokeObjectURL(current.posterUrl)
  current = null
  $file.value = ''
  $panel.hidden = true
  $panel.replaceChildren()
  $drop.hidden = false
  $drop.focus({preventScroll: true})
}

async function chooseFile(file) {
  if (!file) return
  if (current) resetToIdle()
  current = {file, objectUrl: URL.createObjectURL(file)}
  const mine = current

  showReading('Reading the video…')
  try {
    const meta = await readMetadata(file, mine.objectUrl)
    if (mine !== current) return
    mine.meta = meta
    mine.decision = decideDestination(meta.duration)
    mine.name = normaliseName(file.name)

    showReading('Capturing a poster frame…')
    const poster = await capturePoster(meta.video, meta.duration)
    if (mine !== current) return
    mine.poster = poster.blob
    mine.posterUrl = URL.createObjectURL(poster.blob)
  } catch {
    if (mine !== current) return
    showRefused('decode')
    return
  }

  // R2-path checks only apply to clips; Stream takes anything that decoded.
  if (mine.decision === 'r2') {
    const {container, probe} = await probeFile(file)
    if (mine !== current) return
    mine.container = container
    mine.probe = probe
    if (container === 'mov') return showRefused('mov')
    if (container !== 'mp4') return showRefused('decode')
    if (file.size > R2_MAX_BYTES) return showRefused('tooLarge')
    if (!probe.fastStart) return showRefused('fastStart')
  }
  showDecision()
}

async function startR2() {
  const mine = current
  const {file, meta, poster} = mine
  const controller = new AbortController()
  mine.controller = controller
  const {signal} = controller

  let created
  const ui = showUploading({
    label: 'Uploading to R2…',
    sub: 'Preparing',
    onCancel: () => controller.abort(),
  })
  try {
    created = await api('POST', '/r2/create', {fileName: file.name, size: file.size, duration: meta.duration, width: meta.width, height: meta.height}, {signal})
    const partSize = created.partSize
    const total = Math.ceil(file.size / partSize)
    const parts = []
    let doneBytes = 0
    const suffixNote = suffixNotice(created)
    const ui2 = showUploading({label: 'Uploading to R2…', sub: created.suffixed ? `Saving as ${created.name}.mp4` : `Saving as ${created.name}.mp4`, suffixNote, onCancel: () => controller.abort()})
    const paint = (loaded, n) => {
      const sent = Math.min(file.size, doneBytes + loaded)
      const pct = (sent / file.size) * 100
      ui2.set(pct, `<strong>${Math.floor(pct)}%</strong> · part ${n} of ${total}`, `${formatBytes(sent)} of ${formatBytes(file.size)}`)
    }

    for (let n = 1; n <= total; n++) {
      const blob = file.slice((n - 1) * partSize, Math.min(n * partSize, file.size))
      let attempt = 0
      for (;;) {
        try {
          paint(0, n)
          const part = await putBytes(`/r2/part?key=${encodeURIComponent(created.key)}&uploadId=${encodeURIComponent(created.uploadId)}&n=${n}`, blob, {signal, onProgress: (loaded) => paint(loaded, n)})
          parts.push({partNumber: part.partNumber, etag: part.etag})
          doneBytes += blob.size
          break
        } catch (err) {
          if (err.name === 'AbortError') throw err
          if (err.status === 401 || (err.status >= 400 && err.status < 500)) throw err
          if (++attempt > 3) throw new Error(MSG.gaveUp)
          ui2.set(null, `<strong>Connection dropped</strong> · retrying part ${n} (attempt ${attempt} of 3)…`, '')
          await sleep(1000 * 2 ** (attempt - 1), signal)
        }
      }
    }

    ui2.set(100, '<strong>100%</strong> · finishing', formatBytes(file.size))
    const completed = await api('POST', '/r2/complete', {key: created.key, uploadId: created.uploadId, parts}, {signal})
    let posterUrl = null
    try {
      const p = await putBytes(`/r2/poster?key=${encodeURIComponent(created.posterKey)}`, poster, {signal})
      posterUrl = p.url
    } catch (err) {
      if (err.name === 'AbortError') throw err
      // The clip is up; a missing poster is not worth failing the whole upload for.
      console.warn('poster upload failed', err)
    }
    mine.controller = null
    showDone({kind: 'r2', link: completed.url, posterUrl, duration: meta.duration, size: completed.size ?? file.size, suffixNote})
  } catch (err) {
    if (created) api('POST', '/r2/abort', {key: created.key, uploadId: created.uploadId}).catch(() => {})
    mine.controller = null
    if (mine !== current) return
    if (err.name === 'AbortError') return showDecision()
    showError(err.message || MSG.gaveUp, {retry: err.status === 401 ? null : () => startR2()})
  }
}

async function startStream(isOverride) {
  const mine = current
  const {file, meta} = mine
  const controller = new AbortController()
  mine.controller = controller
  const {signal} = controller

  const ui = showUploading({label: 'Uploading to Stream…', sub: 'Asking Cloudflare for an upload slot', onCancel: () => controller.abort()})
  try {
    const {uploadURL, uid} = await api('POST', '/stream/direct-upload', {fileName: file.name, size: file.size}, {signal})
    const ui2 = showUploading({label: 'Uploading to Stream…', sub: isOverride ? MSG.whyOverride : 'Straight from your computer to Cloudflare; this page only watches.', onCancel: () => controller.abort()})
    await tusUpload({
      file,
      uploadUrl: uploadURL,
      signal,
      onProgress: (sent, failures) => {
        const pct = (sent / file.size) * 100
        ui2.set(pct, `<strong>${Math.floor(pct)}%</strong>${failures ? ` · reconnected ${failures}×` : ''}`, `${formatBytes(sent)} of ${formatBytes(file.size)}`)
      },
    })

    // Processing: no percentage to show honestly, so show elapsed time.
    const started = Date.now()
    const ui3 = showUploading({label: MSG.processing, sub: 'You can leave this page; the video also appears under Recent once ready.', indeterminate: true, onCancel: () => controller.abort()})
    const tick = () => ui3.set(null, `<strong>${formatDuration((Date.now() - started) / 1000)}</strong> elapsed`, `Stream id ${uid}`)
    const timer = setInterval(tick, 1000)
    tick()
    let status
    try {
      for (;;) {
        await sleep(4000, signal)
        status = await api('GET', `/stream/status?uid=${uid}`, null, {signal})
        if (status.readyToStream) break
        if (status.state === 'error') throw new Error(status.errorReasonText || 'Cloudflare could not process this video.')
      }
    } finally {
      clearInterval(timer)
    }
    mine.controller = null
    showDone({kind: 'stream', link: status.link, posterUrl: status.thumbnail, duration: status.duration ?? meta.duration, size: status.size ?? file.size})
  } catch (err) {
    mine.controller = null
    if (mine !== current) return
    if (err.name === 'AbortError') return showDecision()
    showError(err.message || MSG.gaveUp, {retry: err.status === 401 ? null : () => startStream(isOverride)})
  }
}

/* ---------- wiring ---------- */

$drop.addEventListener('click', () => $file.click())
$drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    $file.click()
  }
})
$file.addEventListener('change', () => chooseFile($file.files?.[0]))

let dragDepth = 0
document.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return
  dragDepth++
  document.body.classList.add('is-dragging')
  $drop.classList.add('is-over')
})
document.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0
    document.body.classList.remove('is-dragging')
    $drop.classList.remove('is-over')
  }
})
document.addEventListener('dragover', (e) => e.preventDefault())
document.addEventListener('drop', (e) => {
  e.preventDefault()
  dragDepth = 0
  document.body.classList.remove('is-dragging')
  $drop.classList.remove('is-over')
  const file = e.dataTransfer?.files?.[0]
  if (file) chooseFile(file)
})

window.addEventListener('beforeunload', (e) => {
  if (current?.controller) {
    e.preventDefault()
    e.returnValue = ''
  }
})

api('GET', '/api/me')
  .then((data) => {
    me = {...me, ...data}
    $who.textContent = me.email
    if (me.localDev) $who.append(' ', Object.assign(el('span', {class: 'pill pill--muted', text: 'local dev'})))
  })
  .catch((err) => {
    if (err.status === 401) location.reload()
  })

// Exposed for manual poking in DevTools and for the state gallery (?state=…).
window.__upload = {
  chooseFile,
  resetToIdle,
  get current() { return current },
  get me() { return me },
  set me(patch) { me = {...me, ...patch} },
}
