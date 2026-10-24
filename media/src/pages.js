/*
 * Server-rendered pages. The upload page itself is a static file (public/),
 * but these three cannot be:
 *   - 401 / 503 are shown BEFORE the request passes the Access check, so they
 *     cannot load /upload.css (that asset needs the check too) — they inline
 *     the little CSS they need.
 *   - /recent is built from R2 + Stream data on each request.
 */
import {formatBytes, formatDuration} from '../public/lib/names.js'

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const FONTS =
  '<link rel="preconnect" href="https://fonts.googleapis.com" />' +
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />' +
  '<link href="https://fonts.googleapis.com/css2?family=Red+Hat+Display:wght@500;600;700;800&family=Red+Hat+Text:wght@400;500;600&family=Red+Hat+Mono:wght@400;500&display=swap" rel="stylesheet" />'

/* Just enough of the house style for a page that cannot load upload.css. */
const STANDALONE_CSS = `
:root{--navy:#0f1729;--green:#10b77f;--green-deep:#067552;--muted:#f1f5f9;--muted-foreground:#65758b;--border:#e1e7ef;--radius:.75rem;--radius-lg:1.65rem;--font-display:"Red Hat Display",system-ui,sans-serif;--font-text:"Red Hat Text",system-ui,sans-serif}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1.25rem;background:var(--muted);color:var(--navy);font-family:var(--font-text);line-height:1.6;-webkit-font-smoothing:antialiased}
.card{width:100%;max-width:30rem;padding:2.25rem 1.75rem;background:#fff;border:1px solid var(--border);border-radius:var(--radius-lg);box-shadow:0 1px 2px rgb(15 23 41/.04),0 12px 32px -16px rgb(15 23 41/.18);text-align:center}
.mark{display:inline-grid;place-items:center;width:3.25rem;height:3.25rem;border-radius:50%;background:color-mix(in srgb,var(--green) 12%,#fff);color:var(--green-deep);margin-bottom:1.25rem}
h1{font-family:var(--font-display);font-size:1.5rem;letter-spacing:-.025em;line-height:1.15;margin:0 0 .75rem}
p{margin:0;color:var(--muted-foreground)}
p+p{margin-top:.75rem}
code{font-family:"Red Hat Mono",ui-monospace,monospace;font-size:.9em;background:var(--muted);padding:.1em .4em;border-radius:.35em;color:var(--navy)}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:2.75rem;padding:0 1.5rem;margin-top:1.5rem;border-radius:999px;background:var(--navy);color:#f8fafc;font-family:var(--font-display);font-weight:600;font-size:.9375rem;text-decoration:none}
.btn:hover{background:#1d283a}
.foot{margin-top:1.5rem;font-size:.8125rem}
`

function standalone({title, body, status}) {
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${esc(title)} — Kedaipal uploads</title><meta name="robots" content="noindex" />${FONTS}<style>${STANDALONE_CSS}</style></head><body><main class="card">${body}</main></body></html>`,
    {status, headers: {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'}},
  )
}

const LOCK_ICON =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'

/** 401 — no valid Access JWT on the request. */
export function unauthorizedPage() {
  return standalone({
    status: 401,
    title: 'Sign in required',
    body: `
      <div class="mark">${LOCK_ICON}</div>
      <h1>Sign in to upload</h1>
      <p>This page is only for Kedaipal writers. Open <strong>upload.kedaipal.com</strong> directly and sign in with the code sent to your email.</p>
      <p>If you were signed in, your session has ended — open the page again to get a new code.</p>
      <a class="btn" href="https://upload.kedaipal.com/">Open upload.kedaipal.com</a>`,
  })
}

/** JSON flavour of the same thing, for fetch() calls from the page. */
export function unauthorizedJson() {
  return json({error: 'unauthorized', message: 'Your sign-in has expired. Reload the page to sign in again.'}, 401)
}

/** 503 — the Worker has been deployed without the vars that make Access real. */
export function notConfiguredPage(missing) {
  return standalone({
    status: 503,
    title: 'Not configured',
    body: `
      <div class="mark">${LOCK_ICON}</div>
      <h1>Upload page not configured</h1>
      <p>The Worker is deployed but refuses every request until the login can be verified. Missing: ${missing.map((m) => `<code>${esc(m)}</code>`).join(', ')}.</p>
      <p class="foot">Set them in <code>media/wrangler.jsonc</code> (values come from the Cloudflare Access application — ClickUp subtask 1 §C) and redeploy.</p>`,
  })
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers},
  })
}

export function errorJson(status, message, extra = {}) {
  return json({error: true, message, ...extra}, status)
}

/* ---------- /recent ---------- */

const COPY_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>'

function dateLabel(d) {
  const date = d instanceof Date ? d : new Date(d)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-GB', {timeZone: 'Asia/Kuala_Lumpur', day: 'numeric', month: 'short', year: 'numeric'}).format(date)
}

function row({thumb, name, meta, link, kind, processing}) {
  const thumbHtml = thumb
    ? `<img class="recent-thumb" src="${esc(thumb)}" alt="" loading="lazy" width="96" height="54" />`
    : `<div class="recent-thumb recent-thumb--empty" aria-hidden="true"></div>`
  return `
    <li class="recent-row">
      ${thumbHtml}
      <div class="recent-main">
        <div class="recent-name">${esc(name)}${processing ? ' <span class="pill pill--muted">processing</span>' : ''}</div>
        <div class="recent-meta">${meta.map((m) => `<span>${esc(m)}</span>`).join('')}</div>
        <a class="recent-link" href="${esc(link)}" target="_blank" rel="noopener">${esc(link)}</a>
      </div>
      <button class="btn btn-ghost btn-copy" type="button" data-copy="${esc(link)}" aria-label="Copy ${esc(kind)} link">${COPY_ICON}<span>Copy</span></button>
    </li>`
}

/**
 * @param {object} data
 * @param {Array} data.clips     [{name, link, poster, size, duration, uploaded}]
 * @param {Array|null} data.stream  [{uid, name, link, thumbnail, duration, created, ready}] or null when Stream is not configured
 * @param {string|null} data.streamError
 * @param {string} data.email
 */
export function recentPage({clips, stream, streamError, email}) {
  const clipRows = clips.length
    ? `<ul class="recent-list">${clips
        .map((c) =>
          row({
            thumb: c.poster,
            name: c.name,
            meta: [formatDuration(c.duration), formatBytes(c.size), dateLabel(c.uploaded)],
            link: c.link,
            kind: 'clip',
          }),
        )
        .join('')}</ul>`
    : `<p class="empty-note">No clips yet. Drop a short MP4 on the <a href="/">upload page</a> and it will show up here.</p>`

  let streamRows
  if (stream === null) {
    streamRows = `<p class="empty-note">Stream is not connected to this page yet (the <code>STREAM_API_TOKEN</code> secret is missing). Long videos cannot be uploaded until it is.</p>`
  } else if (streamError) {
    streamRows = `<p class="empty-note empty-note--error">Could not load the Stream list: ${esc(streamError)}</p>`
  } else if (!stream.length) {
    streamRows = `<p class="empty-note">No long videos yet. Anything over 5 minutes dropped on the <a href="/">upload page</a> lands here.</p>`
  } else {
    streamRows = `<ul class="recent-list">${stream
      .map((v) =>
        row({
          thumb: v.thumbnail,
          name: v.name,
          meta: [formatDuration(v.duration), dateLabel(v.created)],
          link: v.link,
          kind: 'Stream',
          processing: !v.ready,
        }),
      )
      .join('')}</ul>`
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Recent uploads — Kedaipal</title>
  <meta name="robots" content="noindex" />
  <meta name="theme-color" content="#0F172A" />
  <link rel="icon" href="/favicon.ico" />
  ${FONTS}
  <link rel="stylesheet" href="/upload.css" />
</head>
<body>
  <header class="top">
    <a class="brand" href="/" aria-label="Kedaipal uploads"><img src="/logo.svg" alt="Kedaipal" /><span class="brand-sub">Uploads</span></a>
    <nav class="top-nav" aria-label="Pages">
      <a href="/">Upload</a>
      <a href="/recent" aria-current="page">Recent</a>
    </nav>
    <span class="who" title="${esc(email)}">${esc(email)}</span>
  </header>
  <main class="page page--recent">
    <section class="section-head">
      <span class="eyebrow">Recent uploads</span>
      <h1>Lost a link? It's here.</h1>
      <p class="lede">The last 20 of each kind. Copy the link and paste it into the Studio's Video block.</p>
    </section>
    <section class="recent-group">
      <h2>Clips <span class="h2-sub">stored on media.kedaipal.com</span></h2>
      ${clipRows}
    </section>
    <section class="recent-group">
      <h2>Long videos <span class="h2-sub">Cloudflare Stream</span></h2>
      ${streamRows}
    </section>
  </main>
  <div class="toast" id="toast" role="status" aria-live="polite" hidden>Link copied</div>
  <script type="module" src="/recent.js"></script>
</body>
</html>`
  return new Response(html, {headers: {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'}})
}
