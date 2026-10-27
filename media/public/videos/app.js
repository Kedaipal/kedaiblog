/*
 * admin.kedaipal.com/videos — every video goes to Cloudflare Stream.
 *
 * Views (one at a time, in #view):
 *   loading → sign-in (Clerk, hosted here, sign-in only, always back to /videos)
 *           → no-access ("You don't have admin access" + Go to the Kedaipal app)
 *           → upload: idle → reading → ready → uploading → processing → done
 *                                     ↘ refused        ↘ error / cancelled
 *           → recent (last 20 Stream videos, copy links)
 *   plus: access-check-unavailable, not configured, Clerk failed to load.
 *
 * The link is handed out only once Stream says readyToStream.
 */
import {
  STREAM_MAX_BYTES,
  STREAM_MAX_SECONDS,
  formatBytes,
  formatDuration,
  frontendApiFromKey,
} from './lib/shared.js'
import {tusUpload} from './lib/tus.js'
import {copyText, el, toast} from './lib/ui.js'

const CONFIG = window.ADMIN_VIDEOS_CONFIG || {clerkPublishableKey: '', appUrl: 'https://kedaipal.com/app', missing: ['config']}
const PATH = location.pathname.replace(/\/+$/, '') || '/videos'

const MSG = {
  rule: 'Every video goes to Cloudflare Stream, which plays it at the best quality each reader’s connection can take, so it keeps playing on weak mobile data. Any format a phone or camera records is fine.',
  cost: (min) =>
    `Stream bills about US$5 per 1,000 minutes stored each month, plus US$1 per 1,000 minutes watched${min ? ` — this one adds about ${min} minute${min === 1 ? '' : 's'} of storage` : ''}.`,
  notVideo: "This doesn't look like a video file. Pick the video itself — MP4, MOV, M4V, MKV, WebM or AVI.",
  tooLong: 'This video is longer than 3 hours, which is the most Stream takes in one upload. Split it into parts and upload each one.',
  tooLarge: 'This file is over 30 GB, which is more than Stream accepts in one upload. Export it at 1080p or 720p and try again.',
  noPreview: "Your browser can't preview this format. That's fine — Stream converts it.",
  processing: 'Processing on Cloudflare…',
  processingSub: 'A long video can take several minutes. You can close this page — the link will be under Recent once it is ready.',
  gaveUp: 'The upload stopped after several retries. Check your connection and try again — Stream resumes where it can.',
  expired: 'Your sign-in has expired. Sign in again — the file is still on your computer.',
  streamOff: 'Stream is not connected yet, so videos cannot be uploaded. Ask Zaki.',
  streamFailed: 'Cloudflare could not process this video.',
  playsOnBlog: 'Plays on blog.kedaipal.com only',
}

const ICON = {
  file: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m10 9 5 3-5 3z" fill="currentColor" stroke="none"/></svg>',
  copy: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
  warn: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
  info: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
  check: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5L20 7"/></svg>',
  lock: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  upload: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 16.5V18a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1.5"/></svg>',
}

const VIDEO_EXT = /\.(mp4|m4v|mov|qt|mkv|webm|avi|wmv|flv|mpe?g|3gp|mts|m2ts|ts|ogv)$/i

/* ---------- state ---------- */

const $view = document.getElementById('view')
let me = null // {userId, areas, allowed, streamConfigured}
let current = null // the file being handled
let getToken = async () => null // set once Clerk has loaded

/* ---------- API ---------- */

class ApiError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function api(method, path, body, {signal} = {}) {
  const token = await getToken()
  if (!token) throw new ApiError(401, 'signed-out', MSG.expired)
  const res = await fetch(path, {
    method,
    signal,
    headers: {authorization: `Bearer ${token}`, ...(body ? {'content-type': 'application/json'} : {})},
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(res.status, data?.error || 'error', res.status === 401 ? MSG.expired : data?.message || `Request failed (${res.status})`)
  return data
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(new DOMException('aborted', 'AbortError'))), {once: true})
  })

/* ---------- small render helpers ---------- */

function show(...children) {
  $view.replaceChildren(...children.flat().filter(Boolean))
  window.scrollTo({top: 0})
}

function notice(kind, html, smallHtml) {
  const icon = kind === 'error' ? ICON.warn : kind === 'ok' ? ICON.check : ICON.info
  return el(
    'div',
    {class: `notice notice--${kind}`, role: kind === 'error' ? 'alert' : null},
    el('span', {html: icon}),
    el('div', {}, el('p', {html}), smallHtml ? el('p', {class: 'small', html: smallHtml}) : null),
  )
}

function facts(items) {
  const list = el('ul', {class: 'facts'})
  items.filter(Boolean).forEach(([label, value]) => list.append(el('li', {}, `${label} `, el('strong', {text: value}))))
  return list
}

function gate({mark = ICON.lock, amber = false, title, body = [], actions = [], foot}) {
  return el(
    'div',
    {class: 'gate'},
    el(
      'div',
      {class: 'gate-card'},
      el('div', {class: `gate-mark${amber ? ' gate-mark--amber' : ''}`, html: mark}),
      el('h1', {text: title}),
      ...body.map((b) => (typeof b === 'string' ? el('p', {html: b}) : b)),
      actions.length ? el('div', {class: 'actions'}, ...actions) : null,
      foot ? el('p', {class: 'small', style: 'margin-top:1.25rem'}, ...foot) : null,
    ),
  )
}

function loadingView(text) {
  show(el('div', {class: 'gate'}, el('div', {class: 'gate-loading'}, el('span', {class: 'spinner', 'aria-hidden': 'true'}), text)))
}

function setNav(active) {
  const nav = document.getElementById('nav')
  nav.hidden = !me?.allowed
  nav.querySelectorAll('a').forEach((a) => (a.dataset.nav === active ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')))
}

function signOutButton(label = 'Sign out') {
  return el('button', {type: 'button', onclick: () => signOut()}, label)
}

/* ---------- header: user menu + way back to the app ---------- */

function renderUser(user) {
  const right = document.getElementById('top-right')
  const btn = document.getElementById('user-btn')
  const menu = document.getElementById('user-menu')
  document.getElementById('top-app').href = CONFIG.appUrl
  if (!user) {
    right.hidden = true
    return
  }
  const email = user.primaryEmailAddress?.emailAddress || user.emailAddresses?.[0]?.emailAddress || ''
  const name = user.fullName || user.firstName || email
  const avatar = user.imageUrl ? el('img', {src: user.imageUrl, alt: ''}) : el('span', {class: 'initial', text: (name || '?')[0].toUpperCase()})
  btn.replaceChildren(avatar, el('span', {class: 'label', text: name}))
  menu.replaceChildren(
    el('div', {class: 'who-full'}, el('strong', {text: name}), email !== name ? email : ''),
    el('a', {href: CONFIG.appUrl}, 'Go to the Kedaipal app'),
    el('button', {type: 'button', onclick: () => signOut()}, 'Sign out'),
    el('p', {class: 'hint', text: 'Signing out here also signs you out of the app.'}),
  )
  right.hidden = false
  btn.onclick = (e) => {
    e.stopPropagation()
    const open = menu.hidden
    menu.hidden = !open
    btn.setAttribute('aria-expanded', String(open))
  }
}
document.addEventListener('click', (e) => {
  const menu = document.getElementById('user-menu')
  if (!menu.hidden && !e.target.closest('.menu')) {
    menu.hidden = true
    document.getElementById('user-btn').setAttribute('aria-expanded', 'false')
  }
})

async function signOut() {
  if (current?.controller) current.controller.abort()
  await window.Clerk?.signOut({redirectUrl: '/videos/sign-in'})
}

/* ---------- gate views ---------- */

function signInView() {
  renderUser(null)
  setNav(null)
  const mount = el('div', {id: 'clerk-signin'})
  show(
    el(
      'div',
      {class: 'gate'},
      el(
        'div',
        {class: 'signin-wrap'},
        el(
          'div',
          {class: 'signin-head'},
          el('span', {class: 'eyebrow', text: 'Kedaipal admin'}),
          el('h1', {text: 'Sign in to upload videos'}),
          el('p', {text: 'Use your Kedaipal account — the same one as the app.'}),
        ),
        mount,
      ),
    ),
  )
  window.Clerk.mountSignIn(mount, {
    routing: 'hash',
    forceRedirectUrl: '/videos',
    signUpForceRedirectUrl: '/videos',
    withSignUp: false,
    appearance: {
      variables: {colorPrimary: '#0f1729', fontFamily: '"Red Hat Text", system-ui, sans-serif', borderRadius: '0.75rem'},
      elements: {footerAction: {display: 'none'}},
    },
  })
}

function noAccessView() {
  setNav(null)
  const user = window.Clerk?.user
  const email = user?.primaryEmailAddress?.emailAddress || ''
  show(
    gate({
      amber: true,
      title: "You don't have admin access",
      body: ['This page is for Kedaipal’s blog editors. If you write for the blog, ask Zaki to add your account.'],
      actions: [el('a', {class: 'btn btn-primary', href: CONFIG.appUrl}, 'Go to the Kedaipal app')],
      foot: [email ? `Signed in as ${email} · ` : '', signOutButton('Use another account')],
    }),
  )
}

function problemView(title, message, {retry = true} = {}) {
  setNav(null)
  show(
    gate({
      amber: true,
      mark: ICON.info,
      title,
      body: [message],
      actions: retry ? [el('button', {class: 'btn btn-primary', type: 'button', onclick: () => location.reload()}, 'Try again')] : [],
    }),
  )
}

/* ---------- upload view ---------- */

function uploadView() {
  setNav('upload')
  const input = el('input', {type: 'file', accept: 'video/*,.mp4,.m4v,.mov,.mkv,.webm,.avi', hidden: true, onchange: () => chooseFile(input.files?.[0])})
  const drop = el(
    'section',
    {class: 'drop', id: 'drop', tabindex: '0', role: 'button', 'aria-label': 'Choose a video to upload', 'aria-describedby': 'rule', onclick: () => input.click(), onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), input.click())},
    el('div', {class: 'drop-icon', html: ICON.upload}),
    el('p', {class: 'drop-title', text: 'Drop a video here'}),
    el('p', {class: 'drop-sub'}, 'or ', el('span', {class: 'link', text: 'choose a file'}), ' — any length up to 3 hours'),
    input,
  )
  const panel = el('section', {class: 'panel', id: 'panel', hidden: true, 'aria-live': 'polite'})
  const streamOff = me.streamConfigured ? null : el('div', {style: 'margin-top:1.5rem'}, notice('warn', MSG.streamOff))
  show(
    el(
      'div',
      {class: 'page'},
      el('section', {class: 'section-head'}, el('span', {class: 'eyebrow', text: 'Blog video'}), el('h1', {text: 'Drop a video, get a link.'}), el('p', {class: 'lede', id: 'rule', text: MSG.rule})),
      streamOff,
      drop,
      panel,
      el('p', {class: 'foot-note'}, 'The link appears once Cloudflare has finished processing the video. ', el('a', {href: '/videos/recent'}, 'Recent'), ' keeps every link.'),
    ),
  )
}

function panelRender(...children) {
  const panel = document.getElementById('panel')
  const drop = document.getElementById('drop')
  if (!panel) return
  panel.replaceChildren(fileStrip(current.file), el('div', {class: 'panel-body'}, ...children.flat().filter(Boolean)))
  panel.hidden = false
  drop.hidden = true
}

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

function resetToIdle() {
  if (current?.controller) current.controller.abort()
  if (current?.objectUrl) URL.revokeObjectURL(current.objectUrl)
  current = null
  const panel = document.getElementById('panel')
  const drop = document.getElementById('drop')
  if (!panel) return uploadView()
  panel.hidden = true
  panel.replaceChildren()
  drop.hidden = false
  drop.querySelector('input').value = ''
  drop.focus({preventScroll: true})
}

function readMetadata(objectUrl) {
  return new Promise((resolve) => {
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.muted = true
    video.playsInline = true
    const done = (value) => {
      clearTimeout(timer)
      video.onloadedmetadata = video.onerror = null
      resolve(value)
    }
    const timer = setTimeout(() => done(null), 15000)
    video.onloadedmetadata = () => {
      const {duration, videoWidth, videoHeight} = video
      if (!Number.isFinite(duration) || duration <= 0) return done(null)
      // A frame for the preview box (not uploaded — Stream makes its own thumbnail).
      video.currentTime = Math.min(1, duration * 0.1)
      done({video, duration, width: videoWidth || null, height: videoHeight || null})
    }
    video.onerror = () => done(null)
    video.src = objectUrl
  })
}

function looksLikeVideo(file) {
  return (file.type || '').startsWith('video/') || VIDEO_EXT.test(file.name)
}

async function chooseFile(file) {
  if (!file) return
  if (current) resetToIdle()
  current = {file, objectUrl: URL.createObjectURL(file)}
  const mine = current
  panelRender(el('div', {class: 'status'}, el('span', {class: 'spinner', 'aria-hidden': 'true'}), el('div', {}, el('div', {class: 'status-text', text: 'Reading the video…'}), el('div', {class: 'status-sub', text: 'Nothing is uploaded until you confirm.'}))))
  if (!looksLikeVideo(file)) return refused(MSG.notVideo, "That's not a video")
  if (file.size > STREAM_MAX_BYTES) return refused(MSG.tooLarge, 'Too large for Stream')
  const meta = await readMetadata(mine.objectUrl)
  if (mine !== current) return
  mine.meta = meta
  if (meta && meta.duration > STREAM_MAX_SECONDS) return refused(MSG.tooLong, 'Longer than 3 hours')
  readyView()
}

function refused(message, title) {
  const m = current.meta
  panelRender(
    el('p', {class: 'refused-title', text: title}),
    notice('error', message),
    m ? facts([['Duration', formatDuration(m.duration)], ['Size', formatBytes(current.file.size)]]) : null,
    el('div', {class: 'actions'}, el('button', {class: 'btn btn-primary', type: 'button', onclick: () => resetToIdle()}, 'Pick another file')),
  )
}

function previewBox() {
  const box = el('div', {class: 'route-thumb'})
  if (current.meta?.video) {
    const v = current.meta.video
    v.removeAttribute('controls')
    box.append(v)
  } else box.append(el('div', {class: 'thumb-note', text: MSG.noPreview}))
  return box
}

function readyView() {
  const m = current.meta
  const minutes = m ? Math.max(1, Math.round(m.duration / 60)) : null
  panelRender(
    el(
      'div',
      {class: 'route'},
      previewBox(),
      el(
        'div',
        {},
        el('div', {class: 'route-title'}, 'Ready for Stream', el('span', {class: 'pill pill--amber', text: 'per minute'})),
        el('p', {class: 'route-why', text: 'Cloudflare converts it to several qualities and hands back one link for the Studio.'}),
        facts([
          ['Duration', m ? formatDuration(m.duration) : 'unknown until Stream reads it'],
          ['Size', formatBytes(current.file.size)],
          m?.width ? ['Frame', `${m.width} × ${m.height}`] : null,
        ]),
        el('p', {class: 'cost', text: MSG.cost(minutes)}),
      ),
    ),
    el(
      'div',
      {class: 'actions'},
      el('button', {class: 'btn btn-accent', type: 'button', disabled: !me.streamConfigured, onclick: () => startUpload()}, 'Upload to Stream'),
      me.streamConfigured ? null : el('p', {class: 'hint', text: MSG.streamOff}),
    ),
  )
}

function progressBlock() {
  const fill = el('span')
  const bar = el('div', {class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100'}, fill)
  const left = el('span')
  const right = el('span')
  return {
    node: el('div', {class: 'progress'}, bar, el('div', {class: 'progress-meta'}, left, right)),
    set(pct, leftHtml, rightText) {
      bar.classList.toggle('is-indeterminate', pct == null)
      if (pct != null) {
        fill.style.width = `${pct}%`
        bar.setAttribute('aria-valuenow', String(Math.round(pct)))
      } else fill.style.width = ''
      left.innerHTML = leftHtml
      right.textContent = rightText
    },
    processing() {
      bar.classList.add('is-processing')
    },
  }
}

function busyView({label, sub, onCancel, cancelLabel = 'Cancel'}) {
  const p = progressBlock()
  panelRender(
    el('div', {class: 'status'}, el('span', {class: 'spinner', 'aria-hidden': 'true'}), el('div', {}, el('div', {class: 'status-text', text: label}), el('div', {class: 'status-sub', text: sub}))),
    p.node,
    onCancel ? el('div', {class: 'actions'}, el('button', {class: 'btn btn-outline', type: 'button', onclick: onCancel}, cancelLabel)) : null,
  )
  return p
}

function errorView(message, {retry, signIn} = {}) {
  panelRender(
    el('p', {class: 'refused-title', text: signIn ? 'Signed out' : 'Upload failed'}),
    notice('error', message),
    el(
      'div',
      {class: 'actions'},
      signIn ? el('a', {class: 'btn btn-accent', href: '/videos/sign-in'}, 'Sign in again') : null,
      retry ? el('button', {class: 'btn btn-accent', type: 'button', onclick: retry}, 'Try again') : null,
      el('button', {class: 'btn btn-outline', type: 'button', onclick: () => readyView()}, 'Back'),
    ),
  )
}

function doneView({link, thumbnail, duration, size}) {
  const copyBtn = el('button', {
    class: 'btn btn-primary btn-sm',
    type: 'button',
    html: `${ICON.copy}<span>Copy</span>`,
    onclick: async () => toast((await copyText(link)) ? 'Link copied' : 'Could not copy — select the link and copy it by hand'),
  })
  const preview = thumbnail
    ? el('div', {class: 'preview preview--thumb'}, el('img', {src: thumbnail, alt: 'Stream thumbnail', onerror: (e) => e.target.parentElement.remove()}), el('span', {class: 'play-note', text: MSG.playsOnBlog}))
    : null
  panelRender(
    notice('ok', 'Ready. Cloudflare Stream has finished processing the video.'),
    el('p', {class: 'result-label', style: 'margin-top:1.5rem', text: 'Your link'}),
    el('div', {class: 'linkbox'}, el('code', {text: link}), copyBtn),
    el('p', {class: 'paste-hint', html: 'Paste this into the Studio’s <strong>Video</strong> block (+ → Video).'}),
    preview,
    facts([
      ['Duration', formatDuration(duration)],
      ['Size', formatBytes(size)],
      ['Thumbnail', 'Stream’s own, picked automatically'],
    ]),
    el('div', {class: 'actions'}, el('button', {class: 'btn btn-outline', type: 'button', onclick: () => resetToIdle()}, 'Upload another')),
  )
  copyBtn.focus()
}

async function startUpload() {
  const mine = current
  const {file} = mine
  const controller = new AbortController()
  mine.controller = controller
  const {signal} = controller
  const cancel = () => controller.abort()

  let uid
  try {
    busyView({label: 'Uploading to Stream…', sub: 'Asking Cloudflare for an upload slot', onCancel: cancel}).set(0, '<strong>0%</strong>', `0 B of ${formatBytes(file.size)}`)
    const created = await api('POST', '/videos/api/uploads', {fileName: file.name, size: file.size}, {signal})
    uid = created.uid
    const up = busyView({label: 'Uploading to Stream…', sub: 'Straight from your computer to Cloudflare. Keep this tab open until it finishes.', onCancel: cancel})
    const started = Date.now()
    await tusUpload({
      file,
      uploadUrl: created.uploadURL,
      signal,
      onProgress: (sent, failures) => {
        const pct = (sent / file.size) * 100
        const secs = (Date.now() - started) / 1000
        const eta = sent > 0 && secs > 3 ? ((file.size - sent) / (sent / secs)) : null
        up.set(
          pct,
          `<strong>${Math.floor(pct)}%</strong>${failures ? ` · connection dropped, resumed ${failures}×` : ''}${eta != null && pct < 99.5 ? ` · about ${formatDuration(eta)} left` : ''}`,
          `${formatBytes(sent)} of ${formatBytes(file.size)}`,
        )
      },
    })

    // Processing: Stream reports a percentage once it starts encoding; until then, elapsed time only.
    const t0 = Date.now()
    const proc = busyView({label: MSG.processing, sub: MSG.processingSub, onCancel: () => controller.abort(), cancelLabel: 'Stop watching'})
    proc.processing()
    let pct = null
    const tick = () => proc.set(pct, `<strong>${formatDuration((Date.now() - t0) / 1000)}</strong> elapsed${pct != null ? ` · ${Math.floor(pct)}% encoded` : ''}`, `Stream id ${uid}`)
    tick()
    const timer = setInterval(tick, 1000)
    let status
    try {
      for (;;) {
        await sleep(5000, signal)
        status = await api('GET', `/videos/api/uploads/status?uid=${uid}`, null, {signal})
        if (status.readyToStream && status.link) break
        if (status.state === 'error') throw new ApiError(422, 'stream-failed', `${MSG.streamFailed}${status.errorReasonText ? ` (${status.errorReasonText})` : ''}`)
        pct = status.pctComplete
        tick()
      }
    } finally {
      clearInterval(timer)
    }
    mine.controller = null
    doneView({link: status.link, thumbnail: status.thumbnail, duration: status.duration ?? mine.meta?.duration, size: status.size ?? file.size})
  } catch (err) {
    mine.controller = null
    if (mine !== current) return
    if (err.name === 'AbortError') return readyView()
    if (err.status === 401) return errorView(MSG.expired, {signIn: true})
    if (err.status === 403) return noAccessView()
    const message = err.code === 'stream-failed' ? err.message : err instanceof ApiError ? err.message : MSG.gaveUp
    errorView(message, {retry: () => startUpload()})
  }
}

/* drag & drop anywhere on the upload view */
let dragDepth = 0
document.addEventListener('dragenter', (e) => {
  if (!document.getElementById('drop') || !e.dataTransfer?.types?.includes('Files')) return
  dragDepth++
  document.getElementById('drop').classList.add('is-over')
})
document.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0
    document.getElementById('drop')?.classList.remove('is-over')
  }
})
document.addEventListener('dragover', (e) => e.preventDefault())
document.addEventListener('drop', (e) => {
  e.preventDefault()
  dragDepth = 0
  const drop = document.getElementById('drop')
  if (!drop) return
  drop.classList.remove('is-over')
  const file = e.dataTransfer?.files?.[0]
  if (file && me?.allowed) chooseFile(file)
})
window.addEventListener('beforeunload', (e) => {
  if (current?.controller) {
    e.preventDefault()
    e.returnValue = ''
  }
})

/* ---------- recent view ---------- */

function dateLabel(d) {
  const date = new Date(d)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-GB', {timeZone: 'Asia/Kuala_Lumpur', day: 'numeric', month: 'short', year: 'numeric'}).format(date)
}

function recentRow(v) {
  const thumb = v.thumbnail ? el('img', {class: 'recent-thumb', src: v.thumbnail, alt: '', loading: 'lazy', width: '96', height: '54', onerror: (e) => e.target.replaceWith(el('div', {class: 'recent-thumb recent-thumb--empty', 'aria-hidden': 'true'}))}) : el('div', {class: 'recent-thumb recent-thumb--empty', 'aria-hidden': 'true'})
  const pill = v.failed ? el('span', {class: 'pill pill--red', text: 'failed'}) : !v.ready ? el('span', {class: 'pill pill--muted', text: 'processing'}) : null
  const usable = v.ready && v.link
  return el(
    'li',
    {class: `recent-row${usable ? '' : ' is-pending'}`},
    thumb,
    el(
      'div',
      {class: 'recent-main'},
      el('div', {class: 'recent-name', title: v.name}, v.name, pill ? ' ' : '', pill),
      el('div', {class: 'recent-meta'}, v.duration ? el('span', {text: formatDuration(v.duration)}) : null, el('span', {text: dateLabel(v.created)}), v.mine ? el('span', {text: 'by you'}) : null),
      usable ? el('span', {class: 'recent-link', text: v.link}) : el('span', {class: 'recent-link', text: v.failed ? 'Stream could not process this one' : 'Link appears once it is ready'}),
    ),
    el('button', {
      class: 'btn btn-ghost btn-copy',
      type: 'button',
      disabled: !usable,
      'aria-label': `Copy link for ${v.name}`,
      html: `${ICON.copy}<span>Copy</span>`,
      onclick: async () => toast((await copyText(v.link)) ? 'Link copied' : 'Could not copy — select the link and copy it by hand'),
    }),
  )
}

async function recentView() {
  setNav('recent')
  const body = el('div', {}, el('div', {class: 'empty-note'}, el('span', {class: 'spinner', style: 'display:inline-block;vertical-align:middle;margin-right:.5rem', 'aria-hidden': 'true'}), 'Loading…'))
  show(
    el(
      'div',
      {class: 'page page--recent'},
      el('section', {class: 'section-head'}, el('span', {class: 'eyebrow', text: 'Recent uploads'}), el('h1', {text: "Lost a link? It's here."}), el('p', {class: 'lede', text: 'The last 20 videos on Stream, newest first. Copy a link and paste it into the Studio’s Video block.'})),
      el('section', {class: 'recent-group'}, body),
    ),
  )
  try {
    const data = await api('GET', '/videos/api/recent')
    if (!data.streamConfigured) body.replaceChildren(el('p', {class: 'empty-note', text: MSG.streamOff}))
    else if (!data.videos.length) body.replaceChildren(el('p', {class: 'empty-note'}, 'No videos yet. Drop one on the ', el('a', {href: '/videos'}, 'Videos page'), ' and it will show up here.'))
    else body.replaceChildren(el('ul', {class: 'recent-list'}, ...data.videos.map(recentRow)))
  } catch (err) {
    if (err.status === 401) return (location.href = '/videos/sign-in')
    if (err.status === 403) return noAccessView()
    body.replaceChildren(el('p', {class: 'empty-note empty-note--error', text: `Could not load the list: ${err.message}`}))
  }
}

/* ---------- boot ---------- */

function loadScript(src, attrs = {}) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = src
    s.async = true
    s.crossOrigin = 'anonymous'
    for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v)
    s.onload = resolve
    s.onerror = () => reject(new Error(`Could not load ${src}`))
    document.head.append(s)
  })
}

async function loadClerk() {
  const pk = CONFIG.clerkPublishableKey
  const fapi = frontendApiFromKey(pk)
  if (!fapi) throw new Error('bad publishable key')
  // Clerk Core 3 = clerk-js v6 + a separate UI bundle (v1) — the same majors the
  // Kedaipal app's @clerk/react 6 loads, served by our own Clerk Frontend API.
  await Promise.all([
    loadScript(`https://${fapi}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, {'data-clerk-publishable-key': pk}),
    loadScript(`https://${fapi}/npm/@clerk/ui@1/dist/ui.browser.js`, {'data-clerk-publishable-key': pk}),
  ])
  await window.Clerk.load({
    ui: {ClerkUI: window.__internal_ClerkUICtor},
    signInUrl: '/videos/sign-in',
    signInForceRedirectUrl: '/videos',
    signUpForceRedirectUrl: '/videos',
    afterSignOutUrl: '/videos/sign-in',
  })
}

async function boot() {
  if (CONFIG.missing?.length) return problemView('Not configured', `This page is deployed without ${CONFIG.missing.join(', ')}. Set them in media/wrangler.jsonc.`, {retry: false})
  try {
    await loadClerk()
  } catch (err) {
    console.error(err)
    return problemView('Sign-in could not load', 'The Kedaipal sign-in did not load. Check your connection (or an ad blocker) and try again.')
  }
  const Clerk = window.Clerk
  getToken = async () => (Clerk.session ? Clerk.session.getToken({template: 'convex'}) : null)

  if (!Clerk.user) {
    if (PATH !== '/videos/sign-in') return location.replace('/videos/sign-in')
    return signInView()
  }
  if (PATH === '/videos/sign-in') return location.replace('/videos')

  renderUser(Clerk.user)
  // Signed out in another tab (or in the app) → back to sign-in.
  Clerk.addListener(({user}) => {
    if (!user && !current?.controller) location.replace('/videos/sign-in')
  })

  loadingView('Checking your access…')
  try {
    me = await api('GET', '/videos/api/me')
  } catch (err) {
    if (err.status === 401) return location.replace('/videos/sign-in')
    return problemView('Could not check your access', err.code === 'access-unavailable' ? err.message : `Something went wrong (${err.message}).`)
  }
  if (!me.allowed) return noAccessView()
  if (PATH === '/videos/recent') return recentView()
  uploadView()
}

boot()

// For poking at states in DevTools during local development; holds no secrets.
window.__videos = {
  get me() { return me },
  set me(v) { me = v },
  set getToken(fn) { getToken = fn },
  get current() { return current },
  views: {signInView, noAccessView, problemView, uploadView, recentView, loadingView, renderUser},
  chooseFile,
}
