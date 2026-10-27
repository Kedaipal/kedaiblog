/*
 * admin.kedaipal.com/videos — get a video into a blog post.
 *
 * Two ways in on the main view:
 *   A. Drop a video. The browser reads its length and applies the rule:
 *        ≤ 5 min → clip on our own domain (R2): checks → upload → one link
 *        > 5 min → YouTube: a short guide, then B
 *      Any clip refusal, and the clip decision itself, also offer YouTube.
 *   B. Paste a YouTube link. The Worker checks YouTube will let the blog
 *      embed it, and hands back the clean link.
 *
 * Views (in #view): loading → sign-in → no-access / problem → upload / recent.
 * The file panel inside "upload" walks: reading → decision | refused | youtube
 * guide → uploading → done | error.
 */
import {containerOf, probeFastStart, PROBE_BYTES} from './lib/mp4.js'
import {
  CLIP_MAX_BYTES,
  CLIP_MAX_SECONDS,
  YOUTUBE_STUDIO_URL,
  decideDestination,
  formatBytes,
  formatDuration,
  frontendApiFromKey,
  monthFolder,
  normaliseName,
  videoKey,
} from './lib/shared.js'
import {copyText, el, toast} from './lib/ui.js'
import {parseYouTubeLink} from './lib/youtube.js'

const CONFIG = window.ADMIN_VIDEOS_CONFIG || {clerkPublishableKey: '', appUrl: 'https://kedaipal.com/app', missing: ['config']}
const PATH = location.pathname.replace(/\/+$/, '') || '/videos'

/* ---------- copy: what each state says ---------- */

const MSG = {
  rule: 'Clips up to 5 minutes are stored on our own domain, free and ad-free. Longer videos go on our YouTube channel, which adapts to every reader’s connection.',
  whyClip: 'Under 5 minutes, so it is stored on our own domain: free, no ads, plays right inside the article.',
  whyYouTube: 'Over 5 minutes, so it goes on our YouTube channel — it adapts to every reader’s connection, so a long video keeps playing on weak mobile data.',
  whyChosenYouTube: 'You chose YouTube for this clip.',
  decode: "This file won't play in browsers. Export it as <strong>MP4 (H.264 video, AAC audio)</strong> — in HandBrake: preset <em>Fast 720p30</em> (or 1080p30), tick <em>Web Optimized</em>. Or put it on YouTube instead, which takes any format.",
  fastStart: 'This MP4 would only start playing after it has fully downloaded. Re-export with <strong>Web Optimized / fast start</strong> on (HandBrake: Summary → Web Optimized).',
  mov: 'Clips are stored as MP4. Export this as MP4 — or put it on YouTube instead if you can’t re-export.',
  movHint: 'MP4 means H.264 video + AAC audio — in HandBrake: preset <em>Fast 720p30</em> (or 1080p30), tick <em>Web Optimized</em>.',
  tooLarge: 'Too large for a clip this length — export at 1080p or 720p.',
  gaveUp: 'The upload stopped after several retries. Check your connection and try again — nothing was saved.',
  expired: 'Your sign-in has expired. Sign in again — the file is still on your computer.',
  ytNotYouTube: "That's not a YouTube video link. Open the video on YouTube, press <strong>Share</strong> and copy the link it gives you.",
  ytNotEmbeddable: "YouTube won't let this video play on other sites. In YouTube Studio open the video and set <strong>Visibility</strong> to Public or Unlisted, then <strong>Show more → tick Allow embedding</strong>. Save, and paste the link again.",
  ytNotFound: 'YouTube can’t find this video. Check the link — or it may have been deleted.',
  ytUnreachable: 'Couldn’t reach YouTube to check this video. The link looks right; you can paste it into the Studio, or try again in a minute.',
}

const ICON = {
  file: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m10 9 5 3-5 3z" fill="currentColor" stroke="none"/></svg>',
  copy: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
  warn: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
  info: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
  check: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5L20 7"/></svg>',
  lock: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  upload: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 16.5V18a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1.5"/></svg>',
  youtube: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="4" fill="currentColor"/><path d="m10 9 5 3-5 3z" fill="#fff"/></svg>',
  external: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 7h10v10"/><path d="M7 17 17 7"/></svg>',
}

/* ---------- state ---------- */

const $view = document.getElementById('view')
let me = null // {userId, areas, allowed}
let current = null // the file being handled
let getToken = async () => null // set at boot

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

/** PUT raw bytes with upload progress (fetch has none), authenticated. */
async function putBytes(path, blob, {signal, onProgress} = {}) {
  const token = await getToken()
  if (!token) throw new ApiError(401, 'signed-out', MSG.expired)
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', path)
    xhr.setRequestHeader('authorization', `Bearer ${token}`)
    xhr.setRequestHeader('content-type', 'application/octet-stream')
    xhr.upload.onprogress = (e) => onProgress?.(e.loaded)
    xhr.onload = () => {
      let data = null
      try {
        data = JSON.parse(xhr.responseText)
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data)
      else reject(new ApiError(xhr.status, data?.error || 'error', xhr.status === 401 ? MSG.expired : data?.message || `Upload failed (${xhr.status})`))
    }
    xhr.onerror = () => reject(new ApiError(0, 'network', 'network error'))
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

function copyButton(text, label = 'Copy') {
  return el('button', {
    class: 'btn btn-primary btn-sm',
    type: 'button',
    html: `${ICON.copy}<span>${label}</span>`,
    onclick: async () => toast((await copyText(text)) ? 'Link copied' : 'Could not copy — select the link and copy it by hand'),
  })
}

function linkResult(link, hintHtml) {
  const btn = copyButton(link)
  return {
    btn,
    nodes: [
      el('p', {class: 'result-label', text: 'Your link'}),
      el('div', {class: 'linkbox'}, el('code', {text: link}), btn),
      el('p', {class: 'paste-hint', html: hintHtml}),
    ],
  }
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
  const email = user.primaryEmailAddress?.emailAddress || ''
  const name = user.fullName || user.firstName || email
  const avatar = user.imageUrl ? el('img', {src: user.imageUrl, alt: ''}) : el('span', {class: 'initial', text: (name || '?')[0].toUpperCase()})
  btn.replaceChildren(avatar, el('span', {class: 'label', text: name}))
  menu.replaceChildren(
    el('div', {class: 'who-full'}, el('strong', {text: name}), email !== name ? email : ''),
    el('a', {href: CONFIG.appUrl}, 'Go to the Kedaipal app'),
    el('button', {type: 'button', onclick: () => signOut()}, 'Sign out'),
    el('p', {class: 'hint', text: CONFIG.offline ? 'Offline dev mode — nobody is really signed in.' : 'Signing out here also signs you out of the app.'}),
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
  if (CONFIG.offline) return location.reload()
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
        el('div', {class: 'signin-head'}, el('span', {class: 'eyebrow', text: 'Kedaipal admin'}), el('h1', {text: 'Sign in to add videos'}), el('p', {text: 'Use your Kedaipal account — the same one as the app.'})),
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
  const email = window.Clerk?.user?.primaryEmailAddress?.emailAddress || CONFIG.offline?.email || ''
  show(
    gate({
      amber: true,
      title: "You don't have admin access",
      body: ['This page is for Kedaipal’s blog editors. If you write for the blog, ask Zaki to add your account.'],
      actions: [el('a', {class: 'btn btn-primary', href: CONFIG.appUrl}, 'Go to the Kedaipal app')],
      foot: [email ? `Signed in as ${email} · ` : '', el('button', {type: 'button', onclick: () => signOut()}, 'Use another account')],
    }),
  )
}

function problemView(title, message, {retry = true} = {}) {
  setNav(null)
  show(gate({amber: true, mark: ICON.info, title, body: [message], actions: retry ? [el('button', {class: 'btn btn-primary', type: 'button', onclick: () => location.reload()}, 'Try again')] : []}))
}

/* ---------- main view: two ways in ---------- */

function uploadView() {
  setNav('upload')
  const input = el('input', {type: 'file', accept: 'video/*,.mp4,.m4v,.mov', hidden: true, onchange: () => chooseFile(input.files?.[0])})
  const drop = el(
    'section',
    {
      class: 'drop',
      id: 'drop',
      tabindex: '0',
      role: 'button',
      'aria-label': 'Choose a video',
      'aria-describedby': 'rule',
      onclick: () => input.click(),
      onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), input.click()),
    },
    el('div', {class: 'drop-icon', html: ICON.upload}),
    el('p', {class: 'drop-title', text: 'Drop a video here'}),
    el('p', {class: 'drop-sub'}, 'or ', el('span', {class: 'link', text: 'choose a file'}), ' — the page tells you where it goes'),
    input,
  )
  const panel = el('section', {class: 'panel', id: 'panel', hidden: true, 'aria-live': 'polite'})
  show(
    el(
      'div',
      {class: 'page'},
      el('section', {class: 'section-head'}, el('span', {class: 'eyebrow', text: 'Blog video'}), el('h1', {text: 'Get a video into a post.'}), el('p', {class: 'lede', id: 'rule', text: MSG.rule})),
      el('div', {class: 'routes'}, routeChip('clip', 'Up to 5 min', 'Stored on media.kedaipal.com'), routeChip('youtube', 'Longer', 'On our YouTube channel')),
      drop,
      panel,
      youtubeCheckCard(),
      el('p', {class: 'foot-note'}, 'Nothing is ever overwritten. ', el('a', {href: '/videos/recent'}, 'Recent clips'), ' keeps every clip link; YouTube videos are in ', el('a', {href: YOUTUBE_STUDIO_URL, target: '_blank', rel: 'noopener'}, 'YouTube Studio'), '.'),
    ),
  )
}

function routeChip(kind, title, sub) {
  return el('div', {class: `route-chip route-chip--${kind}`}, el('span', {class: 'route-chip-mark', html: kind === 'youtube' ? ICON.youtube : ICON.file}), el('span', {}, el('strong', {text: title}), el('span', {text: sub})))
}

/* ---------- B. "Already on YouTube?" ---------- */

function youtubeCheckCard() {
  const field = el('input', {
    class: 'yt-input',
    id: 'yt-link',
    type: 'url',
    inputmode: 'url',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: 'https://www.youtube.com/watch?v=…',
    'aria-describedby': 'yt-help',
  })
  const result = el('div', {class: 'yt-result', 'aria-live': 'polite'})
  const button = el('button', {class: 'btn btn-primary', type: 'submit'}, 'Check link')
  const form = el(
    'form',
    {class: 'yt-form', onsubmit: (e) => (e.preventDefault(), checkYouTube(field.value, result, button))},
    el('label', {class: 'sr-only', for: 'yt-link', text: 'YouTube link'}),
    field,
    button,
  )
  return el(
    'section',
    {class: 'yt-card', id: 'yt-card'},
    el('div', {class: 'yt-head'}, el('span', {class: 'yt-mark', html: ICON.youtube}), el('div', {}, el('h2', {text: 'Already on YouTube?'}), el('p', {id: 'yt-help', text: 'Paste its link — the page checks the blog is allowed to play it and gives you the link for the Studio.'}))),
    form,
    result,
  )
}

async function checkYouTube(value, result, button) {
  const parsed = parseYouTubeLink(value)
  if (!parsed) {
    result.replaceChildren(notice('error', MSG.ytNotYouTube))
    return
  }
  button.disabled = true
  result.replaceChildren(el('div', {class: 'status'}, el('span', {class: 'spinner', 'aria-hidden': 'true'}), el('div', {class: 'status-sub', text: 'Asking YouTube…'})))
  try {
    const res = await api('GET', `/videos/api/youtube?url=${encodeURIComponent(value.trim())}`)
    renderYouTubeResult(result, res)
  } catch (err) {
    if (err.status === 401) return result.replaceChildren(notice('error', MSG.expired), el('div', {class: 'actions'}, el('a', {class: 'btn btn-accent', href: '/videos/sign-in'}, 'Sign in again')))
    if (err.status === 403) return noAccessView()
    result.replaceChildren(notice('error', err.message))
  } finally {
    button.disabled = false
  }
}

function renderYouTubeResult(result, {status, video}) {
  if (status === 'not-youtube') return result.replaceChildren(notice('error', MSG.ytNotYouTube))
  if (status === 'not-embeddable') return result.replaceChildren(notice('error', MSG.ytNotEmbeddable), el('div', {class: 'actions'}, studioButton('Open YouTube Studio')))
  if (status === 'not-found') return result.replaceChildren(notice('error', MSG.ytNotFound))
  const {btn, nodes} = linkResult(video.link, 'Paste this into the Studio’s <strong>Video</strong> block (+ → Video).')
  const card = el(
    'div',
    {class: `yt-video${video.short ? ' yt-video--short' : ''}`},
    el('img', {src: video.thumbnail, alt: '', loading: 'lazy', onerror: (e) => e.target.remove()}),
    el('div', {}, el('strong', {class: 'yt-title', text: video.title || 'YouTube video'}), video.channel ? el('span', {class: 'yt-channel', text: video.channel}) : null, video.short ? el('span', {class: 'pill pill--muted', text: 'Short · plays tall'}) : null),
  )
  result.replaceChildren(
    status === 'ok' ? notice('ok', 'Good to go — the blog can play this video.') : notice('warn', MSG.ytUnreachable),
    card,
    ...nodes,
  )
  btn.focus()
}

function studioButton(label) {
  return el('a', {class: 'btn btn-outline', href: YOUTUBE_STUDIO_URL, target: '_blank', rel: 'noopener', html: `<span>${label}</span>${ICON.external}`})
}

/* ---------- A. a dropped file ---------- */

function panelRender(...children) {
  const panel = document.getElementById('panel')
  if (!panel) return
  panel.replaceChildren(fileStrip(current.file), el('div', {class: 'panel-body'}, ...children.flat().filter(Boolean)))
  panel.hidden = false
  document.getElementById('drop').hidden = true
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
  if (current?.posterUrl) URL.revokeObjectURL(current.posterUrl)
  current = null
  const panel = document.getElementById('panel')
  if (!panel) return uploadView()
  panel.hidden = true
  panel.replaceChildren()
  const drop = document.getElementById('drop')
  drop.hidden = false
  drop.querySelector('input').value = ''
  drop.focus({preventScroll: true})
}

function readMetadata(objectUrl) {
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

/** Seek to 2 s (or 10 % if shorter), draw to canvas, JPEG 0.85, ≤ 1280 wide. */
function capturePoster(video, duration) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('decode')), 20000)
    video.onseeked = () => {
      video.onseeked = null
      // A short timeout (not rAF, which pauses in a background tab) lets the
      // decoder hand the seeked frame to the canvas.
      setTimeout(() => {
        clearTimeout(timer)
        try {
          const scale = Math.min(1, 1280 / video.videoWidth)
          const canvas = document.createElement('canvas')
          canvas.width = Math.round(video.videoWidth * scale)
          canvas.height = Math.round(video.videoHeight * scale)
          canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
          canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('decode'))), 'image/jpeg', 0.85)
        } catch {
          reject(new Error('decode'))
        }
      }, 30)
    }
    video.onerror = () => (clearTimeout(timer), reject(new Error('decode')))
    video.currentTime = Math.min(2, duration * 0.1)
  })
}

async function chooseFile(file) {
  if (!file) return
  if (current) resetToIdle()
  current = {file, objectUrl: URL.createObjectURL(file)}
  const mine = current
  panelRender(el('div', {class: 'status'}, el('span', {class: 'spinner', 'aria-hidden': 'true'}), el('div', {}, el('div', {class: 'status-text', text: 'Reading the video…'}), el('div', {class: 'status-sub', text: 'Nothing is uploaded until you confirm.'}))))

  let meta
  try {
    meta = await readMetadata(mine.objectUrl)
  } catch {
    if (mine === current) refused('decode')
    return
  }
  if (mine !== current) return
  mine.meta = meta
  mine.name = normaliseName(file.name)
  if (decideDestination(meta.duration) === 'youtube') return youtubeGuide(false)

  // A clip: it will be served as-is, so it has to be a web-ready MP4.
  const head = await file.slice(0, PROBE_BYTES).arrayBuffer()
  if (mine !== current) return
  const container = containerOf(head)
  if (container === 'mov') return refused('mov')
  if (container !== 'mp4') return refused('decode')
  if (file.size > CLIP_MAX_BYTES) return refused('tooLarge')
  if (!probeFastStart(head).fastStart) return refused('fastStart')
  try {
    const poster = await capturePoster(meta.video, meta.duration)
    if (mine !== current) return
    mine.poster = poster
    mine.posterUrl = URL.createObjectURL(poster)
  } catch {
    if (mine === current) refused('decode')
    return
  }
  clipDecision()
}

function previewBox() {
  const box = el('div', {class: 'route-thumb'})
  if (current.posterUrl) box.append(el('img', {src: current.posterUrl, alt: 'Poster frame'}))
  else if (current.meta?.video) {
    current.meta.video.removeAttribute('controls')
    box.append(current.meta.video)
  } else box.append(el('div', {class: 'thumb-note', text: 'No preview'}))
  return box
}

function metaFacts() {
  const m = current.meta
  return facts([m ? ['Duration', formatDuration(m.duration)] : null, ['Size', formatBytes(current.file.size)], m ? ['Frame', `${m.width} × ${m.height}`] : null])
}

function youtubeButton(label = 'Put it on YouTube instead') {
  return el('button', {class: 'btn btn-outline', type: 'button', onclick: () => youtubeGuide(true)}, label)
}

function clipDecision() {
  panelRender(
    el(
      'div',
      {class: 'route'},
      previewBox(),
      el(
        'div',
        {},
        el('div', {class: 'route-title'}, 'Clip', el('span', {class: 'arrow', text: '→'}), 'our domain', el('span', {class: 'pill', text: 'free'})),
        el('p', {class: 'route-why', text: MSG.whyClip}),
        metaFacts(),
        el('p', {class: 'dest'}, 'Saved as ', el('code', {text: videoKey(monthFolder(), current.name)}), ' — if that name is taken it becomes ', el('code', {text: `${current.name}-2`}), '.'),
      ),
    ),
    el(
      'div',
      {class: 'actions'},
      el('button', {class: 'btn btn-accent', type: 'button', onclick: () => startUpload()}, 'Upload clip'),
      youtubeButton(),
      el('p', {class: 'hint', text: 'YouTube instead: for a clip that should also be on our channel.'}),
    ),
  )
}

function refused(reason) {
  const titles = {decode: "Can't use this file as a clip", fastStart: 'Not a fast-start MP4', mov: 'MOV files are not stored as clips', tooLarge: 'Too large for a clip'}
  const body = {
    decode: notice('error', MSG.decode),
    fastStart: notice('error', MSG.fastStart),
    mov: notice('error', MSG.mov, MSG.movHint),
    tooLarge: notice('error', MSG.tooLarge),
  }[reason]
  panelRender(
    el('p', {class: 'refused-title', text: titles[reason]}),
    body,
    current.meta ? metaFacts() : null,
    el('div', {class: 'actions'}, el('button', {class: 'btn btn-primary', type: 'button', onclick: () => resetToIdle()}, 'Pick another file'), youtubeButton()),
  )
}

/** Long videos (and clips sent there by choice): the YouTube steps, then the check below. */
function youtubeGuide(byChoice) {
  const m = current.meta
  panelRender(
    el(
      'div',
      {class: 'route'},
      previewBox(),
      el(
        'div',
        {},
        el('div', {class: 'route-title'}, byChoice ? 'Clip' : 'Long video', el('span', {class: 'arrow', text: '→'}), 'YouTube', el('span', {class: 'pill pill--yt', text: 'our channel'})),
        el('p', {class: 'route-why', text: byChoice ? MSG.whyChosenYouTube : MSG.whyYouTube}),
        m ? metaFacts() : facts([['Size', formatBytes(current.file.size)]]),
      ),
    ),
    el(
      'ol',
      {class: 'steps'},
      el('li', {html: 'Open <strong>YouTube Studio</strong> and switch to the <strong>Kedaipal</strong> channel (your picture, top right).'}),
      el('li', {html: '<strong>Create → Upload videos</strong> and pick this same file. Audience: <strong>No, it’s not made for kids</strong>.'}),
      el('li', {html: 'Visibility: <strong>Public</strong> for the podcast, <strong>Unlisted</strong> if it should only be seen from the blog. Leave <strong>Show more → Allow embedding</strong> ticked.'}),
      el('li', {html: 'When YouTube has finished processing, copy the video’s link (<strong>Share</strong>) and paste it in <strong>Already on YouTube?</strong> below.'}),
    ),
    el(
      'div',
      {class: 'actions'},
      studioButton('Open YouTube Studio'),
      el('button', {class: 'btn btn-ghost', type: 'button', onclick: () => focusYouTubeField()}, 'I have the link'),
    ),
  )
}

function focusYouTubeField() {
  const card = document.getElementById('yt-card')
  card?.scrollIntoView({behavior: 'smooth', block: 'center'})
  document.getElementById('yt-link')?.focus({preventScroll: true})
}

/* ----- uploading a clip ----- */

function progressBlock() {
  const fill = el('span')
  const bar = el('div', {class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100'}, fill)
  const left = el('span')
  const right = el('span')
  return {
    node: el('div', {class: 'progress'}, bar, el('div', {class: 'progress-meta'}, left, right)),
    set(pct, leftHtml, rightText) {
      if (pct != null) {
        fill.style.width = `${pct}%`
        bar.setAttribute('aria-valuenow', String(Math.round(pct)))
      }
      left.innerHTML = leftHtml
      right.textContent = rightText
    },
  }
}

function suffixNotice(created) {
  if (!created?.suffixed) return null
  return notice('warn', `Saved as <code>${created.name}</code> — <code>${created.wantedName}</code> was already taken, and nothing is ever overwritten.`)
}

function uploadingView(created, onCancel) {
  const p = progressBlock()
  panelRender(
    el('div', {class: 'status'}, el('span', {class: 'spinner', 'aria-hidden': 'true'}), el('div', {}, el('div', {class: 'status-text', text: 'Uploading clip…'}), el('div', {class: 'status-sub', text: created ? `Saving as ${created.name}.mp4 — keep this tab open until it finishes.` : 'Preparing'}))),
    p.node,
    suffixNotice(created),
    el('div', {class: 'actions'}, el('button', {class: 'btn btn-outline', type: 'button', onclick: onCancel}, 'Cancel')),
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
      el('button', {class: 'btn btn-outline', type: 'button', onclick: () => clipDecision()}, 'Back'),
    ),
  )
}

function doneView({link, posterUrl, created}) {
  const {btn, nodes} = linkResult(link, 'Paste this into the Studio’s <strong>Video</strong> block (+ → Video).')
  panelRender(
    notice('ok', 'Uploaded. The clip is live on media.kedaipal.com.'),
    suffixNotice(created),
    el('div', {style: 'margin-top:1.5rem'}, ...nodes),
    el('div', {class: 'preview'}, el('video', {controls: true, playsinline: true, preload: 'metadata', poster: posterUrl || null, src: link})),
    facts([['Duration', formatDuration(current.meta?.duration)], ['Size', formatBytes(current.file.size)], ['Poster', posterUrl ? 'captured automatically, same name .jpg' : 'not saved — the block can take one']]),
    el('div', {class: 'actions'}, el('button', {class: 'btn btn-outline', type: 'button', onclick: () => resetToIdle()}, 'Add another video')),
  )
  btn.focus()
}

async function startUpload() {
  const mine = current
  const {file, meta, poster} = mine
  const controller = new AbortController()
  mine.controller = controller
  const {signal} = controller
  const cancel = () => controller.abort()
  let created
  try {
    uploadingView(null, cancel).set(0, '<strong>0%</strong>', `0 B of ${formatBytes(file.size)}`)
    created = await api('POST', '/videos/api/r2/create', {fileName: file.name, size: file.size, duration: meta.duration, width: meta.width, height: meta.height}, {signal})
    const total = Math.ceil(file.size / created.partSize)
    const ui = uploadingView(created, cancel)
    const parts = []
    let doneBytes = 0
    const paint = (loaded, n) => {
      const sent = Math.min(file.size, doneBytes + loaded)
      const pct = (sent / file.size) * 100
      ui.set(pct, `<strong>${Math.floor(pct)}%</strong> · part ${n} of ${total}`, `${formatBytes(sent)} of ${formatBytes(file.size)}`)
    }
    for (let n = 1; n <= total; n++) {
      const blob = file.slice((n - 1) * created.partSize, Math.min(n * created.partSize, file.size))
      for (let attempt = 0; ; ) {
        try {
          paint(0, n)
          const q = `key=${encodeURIComponent(created.key)}&uploadId=${encodeURIComponent(created.uploadId)}&n=${n}`
          const part = await putBytes(`/videos/api/r2/part?${q}`, blob, {signal, onProgress: (loaded) => paint(loaded, n)})
          parts.push({partNumber: part.partNumber, etag: part.etag})
          doneBytes += blob.size
          break
        } catch (err) {
          if (err.name === 'AbortError' || (err.status >= 400 && err.status < 500)) throw err
          if (++attempt > 3) throw new ApiError(0, 'gave-up', MSG.gaveUp)
          ui.set(null, `<strong>Connection dropped</strong> · retrying part ${n} (attempt ${attempt} of 3)…`, '')
          await sleep(1000 * 2 ** (attempt - 1), signal)
        }
      }
    }
    ui.set(100, '<strong>100%</strong> · finishing', formatBytes(file.size))
    const completed = await api('POST', '/videos/api/r2/complete', {key: created.key, uploadId: created.uploadId, parts}, {signal})
    let posterUrl = null
    try {
      posterUrl = (await putBytes(`/videos/api/r2/poster?key=${encodeURIComponent(created.posterKey)}`, poster, {signal})).url
    } catch (err) {
      if (err.name === 'AbortError') throw err
      console.warn('poster upload failed', err) // the clip is up; a missing poster isn't worth failing it for
    }
    mine.controller = null
    doneView({link: completed.url, posterUrl, created})
  } catch (err) {
    if (created) api('POST', '/videos/api/r2/abort', {key: created.key, uploadId: created.uploadId}).catch(() => {})
    mine.controller = null
    if (mine !== current) return
    if (err.name === 'AbortError') return clipDecision()
    if (err.status === 401) return errorView(MSG.expired, {signIn: true})
    if (err.status === 403) return noAccessView()
    errorView(err.message || MSG.gaveUp, {retry: () => startUpload()})
  }
}

/* drag & drop anywhere on the main view */
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

/* ---------- recent clips ---------- */

function dateLabel(d) {
  const date = new Date(d)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-GB', {timeZone: 'Asia/Kuala_Lumpur', day: 'numeric', month: 'short', year: 'numeric'}).format(date)
}

function recentRow(c) {
  const empty = () => el('div', {class: 'recent-thumb recent-thumb--empty', 'aria-hidden': 'true'})
  return el(
    'li',
    {class: 'recent-row'},
    c.poster ? el('img', {class: 'recent-thumb', src: c.poster, alt: '', loading: 'lazy', width: '96', height: '54', onerror: (e) => e.target.replaceWith(empty())}) : empty(),
    el(
      'div',
      {class: 'recent-main'},
      el('div', {class: 'recent-name', title: c.name, text: c.name}),
      // Non-breaking inside each fact, so a narrow row only ever breaks after a "·".
      el('div', {class: 'recent-meta'}, el('span', {text: [c.duration ? formatDuration(c.duration) : null, formatBytes(c.size), dateLabel(c.uploaded)].filter(Boolean).map((t) => t.replace(/ /g, '\u00a0')).join(' · ')})),
      el('a', {class: 'recent-link', href: c.link, target: '_blank', rel: 'noopener', text: c.link}),
    ),
    el('button', {
      class: 'btn btn-ghost btn-copy',
      type: 'button',
      'aria-label': `Copy link for ${c.name}`,
      html: `${ICON.copy}<span>Copy</span>`,
      onclick: async () => toast((await copyText(c.link)) ? 'Link copied' : 'Could not copy — select the link and copy it by hand'),
    }),
  )
}

async function recentView() {
  setNav('recent')
  const body = el('div', {}, el('div', {class: 'empty-note'}, el('span', {class: 'spinner spinner--inline', 'aria-hidden': 'true'}), 'Loading…'))
  show(
    el(
      'div',
      {class: 'page page--recent'},
      el('section', {class: 'section-head'}, el('span', {class: 'eyebrow', text: 'Recent clips'}), el('h1', {text: "Lost a link? It's here."}), el('p', {class: 'lede', text: 'The last 20 clips stored on media.kedaipal.com, newest first. Copy a link and paste it into the Studio’s Video block.'})),
      el('section', {class: 'recent-group'}, body),
      el('section', {class: 'recent-group'}, el('div', {class: 'yt-aside'}, el('span', {class: 'yt-mark', html: ICON.youtube}), el('p', {}, 'Long videos live on our YouTube channel — their links are in YouTube Studio under ', el('strong', {text: 'Content'}), '.'), studioButton('YouTube Studio'))),
    ),
  )
  try {
    const {clips} = await api('GET', '/videos/api/recent')
    body.replaceChildren(clips.length ? el('ul', {class: 'recent-list'}, ...clips.map(recentRow)) : el('p', {class: 'empty-note'}, 'No clips yet. Drop a short MP4 on the ', el('a', {href: '/videos'}, 'Videos page'), ' and it will show up here.'))
  } catch (err) {
    if (err.status === 401) return location.replace('/videos/sign-in')
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

  if (CONFIG.offline) {
    // `npm run dev:offline`: a locally minted token, verified by the Worker
    // against a local mock issuer. Never present on a deployed page.
    getToken = async () => CONFIG.offline.token
    renderUser({fullName: CONFIG.offline.name, primaryEmailAddress: {emailAddress: CONFIG.offline.email}})
    document.getElementById('offline-pill').hidden = false
    if (PATH === '/videos/sign-in') return location.replace('/videos')
  } else {
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
  }

  loadingView('Checking your access…')
  try {
    me = await api('GET', '/videos/api/me')
  } catch (err) {
    if (err.status === 401) return CONFIG.offline ? problemView('Offline token rejected', err.message) : location.replace('/videos/sign-in')
    return problemView('Could not check your access', err.code === 'access-unavailable' ? err.message : `Something went wrong (${err.message}).`)
  }
  if (!me.allowed) return noAccessView()
  if (PATH === '/videos/recent') return recentView()
  uploadView()
}

boot()
