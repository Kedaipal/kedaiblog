/*
 * Data layer + HTML helpers shared by index.html and post.html.
 * Reads published posts from Sanity's public HTTP API (no token needed for a public dataset).
 */
window.Blog = (function () {
  const cfg = window.SANITY_CONFIG || {};
  const live = Boolean(cfg.projectId);

  const IMAGE = `{alt, crop, hotspot, asset->{url, metadata{dimensions}}}`;
  const CARD = `
    title, "slug": slug.current, excerpt, publishedAt, featured, coverText, coverStyle,
    mainImage${IMAGE},
    "category": category->{title, "slug": slug.current},
    "author": author->{name, role, image${IMAGE}},
    "chars": length(pt::text(body))`;

  async function query(groq, params = {}) {
    const host = cfg.useCdn === false ? 'api' : 'apicdn';
    const url = new URL(`https://${cfg.projectId}.${host}.sanity.io/v${cfg.apiVersion}/data/query/${cfg.dataset}`);
    url.searchParams.set('query', groq);
    for (const [k, v] of Object.entries(params)) url.searchParams.set('$' + k, JSON.stringify(v));
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Sanity responded ${res.status}`);
    return (await res.json()).result;
  }

  // ---------- Queries ----------

  const demo = () => {
    const d = window.KEDAIPAL_DEMO;
    const withChars = p => ({ ...p, chars: blocksToText(p.body).length });
    return { categories: d.categories, posts: d.posts.map(withChars) };
  };

  async function getIndex() {
    if (!live) return demo();
    return query(`{
      "categories": *[_type == "category"] | order(order asc, title asc){title, "slug": slug.current},
      "posts": *[_type == "post" && defined(slug.current) && publishedAt <= now()] | order(publishedAt desc){${CARD}}
    }`);
  }

  async function getPost(slug) {
    let post, others;
    if (!live) {
      const { posts } = demo();
      post = posts.find(p => p.slug === slug);
      others = posts.filter(p => p.slug !== slug);
    } else {
      const r = await query(`{
        "post": *[_type == "post" && slug.current == $slug][0]{
          ${CARD},
          articleImage${IMAGE},
          articleImageMobile${IMAGE},
          body[]{..., _type == "image" => ${IMAGE.slice(0, -1)}, caption}, _type == "audio" => {"src": file.asset->url}, _type == "gallery" => {caption, "images": images[]${IMAGE.slice(0, -1)}, caption}}, _type == "video" => {link, aspect, title, caption, "poster": poster{crop, hotspot, asset->{url, metadata{dimensions}}}}}
        },
        "others": *[_type == "post" && slug.current != $slug && publishedAt <= now()] | order(publishedAt desc)[0...12]{${CARD}}
      }`, { slug });
      post = r.post; others = r.others;
    }
    if (!post) return null;
    // Related: same category first, then newest
    const sameCat = p => (p.category?.slug === post.category?.slug ? 0 : 1);
    post.related = [...others].sort((a, b) => sameCat(a) - sameCat(b)).slice(0, 3);
    return post;
  }

  // ---------- Helpers ----------

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const formatDate = iso => iso
    ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : '';

  const readTime = chars => `${Math.max(1, Math.round((chars || 0) / 5 / 200))} min read`;

  const postUrl = slug => `post.html?slug=${encodeURIComponent(slug)}`;

  const initials = name => (name || 'K').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();

  // Sanity image CDN URL, honouring the crop and hotspot set in the Studio
  function imageUrl(img, w, h) {
    const a = img?.asset;
    if (!a?.url) return '';
    const u = new URL(a.url);
    const d = a.metadata?.dimensions;
    const c = img.crop;
    if (c && d) {
      const left = Math.round(c.left * d.width), top = Math.round(c.top * d.height);
      const width = Math.round(d.width * (1 - c.left - c.right)), height = Math.round(d.height * (1 - c.top - c.bottom));
      if (left || top || width !== d.width || height !== d.height) u.searchParams.set('rect', `${left},${top},${width},${height}`);
    }
    u.searchParams.set('w', w);
    if (h) {
      u.searchParams.set('h', h);
      u.searchParams.set('fit', 'crop');
      if (img.hotspot) {
        const cl = c?.left || 0, cr = c?.right || 0, ct = c?.top || 0, cb = c?.bottom || 0;
        u.searchParams.set('crop', 'focalpoint');
        u.searchParams.set('fp-x', ((img.hotspot.x - cl) / (1 - cl - cr)).toFixed(3));
        u.searchParams.set('fp-y', ((img.hotspot.y - ct) / (1 - ct - cb)).toFixed(3));
      }
    }
    u.searchParams.set('auto', 'format');
    u.searchParams.set('q', '80');
    return u.toString();
  }

  function imgTag(img, w, h, { alt = '', eager = false } = {}) {
    const src = imageUrl(img, w, h);
    const src2x = imageUrl(img, w * 2, h && h * 2);
    return `<img src="${esc(src)}" srcset="${esc(src)} 1x, ${esc(src2x)} 2x" alt="${esc(img.alt || alt)}"`
      + ` ${h ? `width="${w}" height="${h}"` : ''} loading="${eager ? 'eager' : 'lazy'}" decoding="async" />`;
  }

  // Branded colour block, used when a post has no images
  function placeholder(post) {
    const style = { light: ' cover--light', green: ' cover--green' }[post.coverStyle] || '';
    return `<div class="cover${style}"><span class="cover-mark">${esc(post.coverText || post.title)}</span></div>`;
  }

  const has = img => Boolean(img?.asset);

  // Card image: 16:10 on the blog home and in "Keep reading" (600×375 @1x)
  function cover(post, { eager = false } = {}) {
    if (!has(post.mainImage)) return placeholder(post);
    return `<div class="cover">${imgTag(post.mainImage, 600, 375, { alt: post.title, eager })}</div>`;
  }

  // Article banner: 21:9 on desktop/tablet (900×386 @1x), 16:10 on phones (600×375 @1x).
  // Each falls back to the card image, so one upload is still enough.
  function articleCover(post) {
    const desktop = [post.articleImage, post.mainImage, post.articleImageMobile].find(has);
    const phone = [post.articleImageMobile, post.mainImage, post.articleImage].find(has);
    if (!desktop) return placeholder(post);
    const src = (img, w, h) => `${esc(imageUrl(img, w, h))} 1x, ${esc(imageUrl(img, w * 2, h * 2))} 2x`;
    const alt = desktop.alt || post.title;
    return `
      <div class="cover">
        <picture>
          <source media="(max-width: 767px)" srcset="${src(phone, 600, 375)}" />
          <img src="${esc(imageUrl(desktop, 900, 386))}" srcset="${src(desktop, 900, 386)}" alt="${esc(alt)}" fetchpriority="high" decoding="async" />
        </picture>
      </div>`;
  }

  function avatar(author) {
    if (author?.image?.asset) return `<span class="avatar">${imgTag(author.image, 72, 72, { alt: author.name })}</span>`;
    return `<span class="avatar">${esc(initials(author?.name))}</span>`;
  }

  function card(post, { excerpt = true } = {}) {
    return `
      <a class="card" href="${postUrl(post.slug)}" data-category="${esc(post.category?.slug)}">
        ${cover(post)}
        <div class="meta">${post.category ? `<span class="tag">${esc(post.category.title)}</span>` : ''}<span>${readTime(post.chars)}</span></div>
        <h3>${esc(post.title)}</h3>
        ${excerpt && post.excerpt ? `<p>${esc(post.excerpt)}</p>` : ''}
      </a>`;
  }

  // ---------- Audio player ----------

  const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z"/></svg>';
  const ICON_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';

  function audioPlayer(b) {
    const caption = b.caption?.trim();
    const long = caption && caption.length > 240;
    return `
      <figure class="audio">
        <button class="audio-play" type="button" aria-label="Play: ${esc(b.title)}">${ICON_PLAY}</button>
        <div class="audio-body">
          <strong class="audio-title">${esc(b.title)}</strong>
          <div class="audio-row">
            <input class="audio-seek" type="range" min="0" max="100" step="0.1" value="0" aria-label="Seek" />
            <span class="audio-time">0:00</span>
          </div>
        </div>
        <audio preload="metadata" src="${esc(b.src)}"></audio>
        ${caption ? (long
          ? `<details class="audio-transcript"><summary>Read transcript</summary><p>${esc(caption).replace(/\n/g, '<br />')}</p></details>`
          : `<figcaption>${esc(caption)}</figcaption>`) : ''}
      </figure>`;
  }

  const clock = t => (isFinite(t) ? `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}` : '0:00');

  // Wires up every player inside `root`. Only one plays at a time.
  function initAudio(root = document) {
    const players = [...root.querySelectorAll('.audio')];
    players.forEach(fig => {
      const audio = fig.querySelector('audio');
      const btn = fig.querySelector('.audio-play');
      const seek = fig.querySelector('.audio-seek');
      const time = fig.querySelector('.audio-time');
      const title = fig.querySelector('.audio-title').textContent;
      const paint = () => {
        const p = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
        seek.value = p;
        seek.style.setProperty('--p', p + '%');
        time.textContent = audio.currentTime > 0 ? `${clock(audio.currentTime)} / ${clock(audio.duration)}` : clock(audio.duration);
      };
      btn.addEventListener('click', () => {
        if (audio.paused) {
          players.forEach(other => other !== fig && other.querySelector('audio').pause());
          audio.play();
        } else audio.pause();
      });
      audio.addEventListener('play', () => { btn.innerHTML = ICON_PAUSE; btn.setAttribute('aria-label', `Pause: ${title}`); fig.classList.add('is-playing'); });
      audio.addEventListener('pause', () => { btn.innerHTML = ICON_PLAY; btn.setAttribute('aria-label', `Play: ${title}`); fig.classList.remove('is-playing'); });
      audio.addEventListener('ended', () => { audio.currentTime = 0; paint(); });
      ['loadedmetadata', 'timeupdate', 'durationchange'].forEach(ev => audio.addEventListener(ev, paint));
      seek.addEventListener('input', () => {
        if (audio.duration) audio.currentTime = (seek.value / 100) * audio.duration;
        paint();
      });
    });
  }

  // ---------- Image gallery + lightbox ----------

  // Keeps the hotspot in view when CSS crops the image into a grid cell or carousel card
  function focus(img) {
    const h = img.hotspot, c = img.crop || {};
    if (!h) return '50% 50%';
    const cl = c.left || 0, cr = c.right || 0, ct = c.top || 0, cb = c.bottom || 0;
    const x = ((h.x - cl) / (1 - cl - cr)) * 100, y = ((h.y - ct) / (1 - ct - cb)) * 100;
    return `${Math.min(100, Math.max(0, x)).toFixed(1)}% ${Math.min(100, Math.max(0, y)).toFixed(1)}%`;
  }

  // Desktop: grid laid out by image count (1–4); with 5–10, the first 4 show and the
  // 4th tile reads "+N". Phones: swipeable carousel of every image. All open in the lightbox.
  function gallery(b) {
    const imgs = b.images.filter(img => img?.asset?.url).slice(0, 10);
    if (!imgs.length) return '';
    const n = imgs.length;
    const more = n - 4;
    const items = imgs.map((img, i) => `
      <button class="gallery-item" type="button" data-index="${i}"
        data-full="${esc(imageUrl(img, 1800))}" data-caption="${esc(img.caption || '')}"
        aria-label="Open image ${i + 1} of ${n}${img.alt ? `: ${esc(img.alt)}` : ''}">
        <img src="${esc(imageUrl(img, 800))}" srcset="${esc(imageUrl(img, 800))} 1x, ${esc(imageUrl(img, 1600))} 2x"
          alt="${esc(img.alt || '')}" loading="lazy" decoding="async" style="object-position: ${focus(img)}" />
        ${i === 3 && more > 0 ? `<span class="gallery-more" aria-hidden="true">+${more}</span>` : ''}
      </button>`).join('');
    const dots = n > 1
      ? `<div class="gallery-dots" aria-hidden="true">${imgs.map((_, i) => `<span${i === 0 ? ' class="is-active"' : ''}></span>`).join('')}</div>`
      : '';
    return `
      <figure class="gallery" data-count="${Math.min(n, 4)}" data-total="${n}">
        <div class="gallery-track">${items}</div>
        ${dots}
        ${b.caption ? `<figcaption>${esc(b.caption)}</figcaption>` : ''}
      </figure>`;
  }

  const ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  const ICON_PREV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>';
  const ICON_NEXT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

  // One shared full-screen viewer for every gallery on the page
  const lightbox = (() => {
    let el, img, caption, count, prev, next, items = [], index = 0, lastFocus = null, touchX = null;

    function build() {
      el = document.createElement('div');
      el.className = 'lightbox';
      el.hidden = true;
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('aria-label', 'Image viewer');
      el.innerHTML = `
        <button class="lb-btn lb-close" type="button" aria-label="Close">${ICON_X}</button>
        <button class="lb-btn lb-prev" type="button" aria-label="Previous image">${ICON_PREV}</button>
        <figure class="lb-figure"><img class="lb-img" alt="" /><figcaption class="lb-caption"></figcaption></figure>
        <button class="lb-btn lb-next" type="button" aria-label="Next image">${ICON_NEXT}</button>
        <div class="lb-count" aria-live="polite"></div>`;
      document.body.append(el);
      img = el.querySelector('.lb-img');
      caption = el.querySelector('.lb-caption');
      count = el.querySelector('.lb-count');
      prev = el.querySelector('.lb-prev');
      next = el.querySelector('.lb-next');
      el.querySelector('.lb-close').addEventListener('click', close);
      prev.addEventListener('click', () => show(index - 1));
      next.addEventListener('click', () => show(index + 1));
      // Click on the dark backdrop closes; clicks on the image or buttons don't
      el.addEventListener('click', e => { if (e.target === el || e.target.classList.contains('lb-figure')) close(); });
      el.addEventListener('touchstart', e => { touchX = e.touches[0].clientX; }, { passive: true });
      el.addEventListener('touchend', e => {
        if (touchX === null) return;
        const dx = e.changedTouches[0].clientX - touchX;
        touchX = null;
        if (Math.abs(dx) > 50 && items.length > 1) show(index + (dx < 0 ? 1 : -1));
      });
      document.addEventListener('keydown', e => {
        if (el.hidden) return;
        if (e.key === 'Escape') close();
        else if (e.key === 'ArrowLeft') show(index - 1);
        else if (e.key === 'ArrowRight') show(index + 1);
        else if (e.key === 'Tab') { // keep focus inside the viewer
          const f = [...el.querySelectorAll('.lb-btn')].filter(b => !b.hidden);
          const i = f.indexOf(document.activeElement);
          e.preventDefault();
          f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
        }
      });
    }

    function show(i) {
      index = (i + items.length) % items.length;
      const it = items[index];
      img.src = it.src;
      img.alt = it.alt;
      caption.textContent = it.caption;
      caption.hidden = !it.caption;
      count.textContent = items.length > 1 ? `${index + 1} / ${items.length}` : '';
      prev.hidden = next.hidden = items.length < 2;
    }

    function open(list, i, trigger) {
      if (!el) build();
      items = list;
      lastFocus = trigger || document.activeElement;
      show(i);
      el.hidden = false;
      document.documentElement.classList.add('lb-open');
      el.querySelector('.lb-close').focus();
    }

    function close() {
      el.hidden = true;
      img.removeAttribute('src');
      document.documentElement.classList.remove('lb-open');
      lastFocus?.focus();
    }

    return { open };
  })();

  function initGallery(root = document) {
    root.querySelectorAll('.gallery').forEach(fig => {
      const buttons = [...fig.querySelectorAll('.gallery-item')];
      const items = buttons.map(btn => ({
        src: btn.dataset.full,
        alt: btn.querySelector('img').alt,
        caption: btn.dataset.caption,
      }));
      buttons.forEach((btn, i) => btn.addEventListener('click', () => lightbox.open(items, i, btn)));

      // Phone carousel: highlight the dot for the card in view
      const track = fig.querySelector('.gallery-track');
      const dots = [...fig.querySelectorAll('.gallery-dots span')];
      if (dots.length) {
        track.addEventListener('scroll', () => {
          const step = buttons[1].offsetLeft - buttons[0].offsetLeft || 1;
          const active = Math.min(dots.length - 1, Math.round(track.scrollLeft / step));
          dots.forEach((d, i) => d.classList.toggle('is-active', i === active));
        }, { passive: true });
      }
    });
  }

  // ---------- Video (clip on R2, YouTube, or Cloudflare Stream) ----------

  // The ONLY link shapes a Video block accepts. Clips up to 5 minutes are uploaded at
  // admin.kedaipal.com/videos and stored on R2 (media.kedaipal.com); long videos live on
  // the Kedaipal YouTube channel. Stream is dormant (no account) but still parsed, so
  // nothing published ever breaks if it returns. The Studio input (studio/schemaTypes/VideoLinkInput.jsx) copies
  // these two regexes VERBATIM so the Studio refuses exactly what the site skips;
  // change them in both places together.
  //   Clip:   https://media.kedaipal.com/videos/<folder>/<name>.mp4   (folder is yyyy-mm; _test for smoke files)
  //   YouTube: watch?v=, youtu.be/, /shorts/, /live/, /embed/, m.youtube.com, youtube-nocookie embed.
  //           The same regex is in media/public/videos/lib/youtube.js (the admin page).
  //           Only the 11-character id is ever used; the rest of the stored link is ignored.
  //   Stream: https://customer-<code>.cloudflarestream.com/<uid>/iframe, …/<uid>/watch, or a bare 32-hex uid.
  //           The customer code is captured only so the Studio can preview a thumbnail;
  //           the site rebuilds the player URL from the uid + STREAM_CUSTOMER_CODE.
  const VIDEO_FILE_RE = /^https:\/\/media\.kedaipal\.com\/videos\/([A-Za-z0-9_-]+)\/([A-Za-z0-9][A-Za-z0-9._-]*\.mp4)$/;
  const VIDEO_YOUTUBE_RE = /^https:\/\/(?:(?:www\.|m\.)?youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/|www\.youtube-nocookie\.com\/embed\/)([A-Za-z0-9_-]{11})(?=$|[?&#/])\S*$/;
  const VIDEO_STREAM_RE = /^(?:https:\/\/(customer-[a-z0-9]+)\.cloudflarestream\.com\/([0-9a-f]{32})\/(?:iframe|watch)\/?(?:\?[^\s#]*)?|([0-9a-f]{32}))$/;

  const streamHost = () => (window.STREAM_CUSTOMER_CODE ? `https://customer-${window.STREAM_CUSTOMER_CODE}.cloudflarestream.com` : '');

  // → {kind: 'file', src, poster} | {kind: 'youtube', id, short, poster}
  //   | {kind: 'stream', uid, src, poster} | null.
  // For Stream, src/poster are null until STREAM_CUSTOMER_CODE is set in js/config.js.
  function parseVideoLink(link) {
    const s = String(link ?? '').trim();
    let m = VIDEO_FILE_RE.exec(s);
    if (m) return { kind: 'file', src: s, poster: s.replace(/\.mp4$/, '.jpg'), name: m[2] };
    m = VIDEO_YOUTUBE_RE.exec(s);
    // embed/videoseries?list=… is a playlist, not an 11-character video id
    if (m && m[1] !== 'videoseries') return { kind: 'youtube', id: m[1], short: /^https:\/\/(?:www\.|m\.)?youtube\.com\/shorts\//.test(s), poster: `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg` };
    m = VIDEO_STREAM_RE.exec(s);
    if (m) {
      const uid = m[2] || m[3];
      const host = streamHost();
      return {
        kind: 'stream',
        uid,
        src: host ? `${host}/${uid}/iframe?preload=metadata` : null,
        poster: host ? `${host}/${uid}/thumbnails/thumbnail.jpg` : null,
      };
    }
    return null;
  }

  // "W/H" string (the block's aspect, written by the Studio) → "W / H" for CSS, else null
  function aspectCss(value) {
    const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(String(value ?? ''));
    const w = Number(m?.[1]), h = Number(m?.[2]);
    return w > 0 && h > 0 ? `${w} / ${h}` : null;
  }

  // A poster override, cut by the Sanity CDN to the frame's exact shape (honouring the
  // Studio's crop and hotspot), so it covers the frame edge to edge. A <video>'s poster
  // follows the video's object-fit, which stays `contain` so the clip itself is never
  // cropped; serving the poster at the frame's shape gives the cover look in every browser.
  function posterFor(img, aspect) {
    if (!has(img)) return null;
    const [aw, ah] = aspect.split(' / ').map(Number);
    const w = aw >= ah ? 1344 : Math.round((1344 * aw) / ah);
    const h = aw >= ah ? Math.round((1344 * ah) / aw) : 1344;
    return imageUrl(img, w, h);
  }

  // The box is sized by --aspect before any media loads, so the article never jumps.
  // The frame always takes the VIDEO's shape: the clip's own aspect (read from its file by
  // the Studio), else 9:16 for a YouTube Short, else 16:9. A poster override never sets
  // it; the poster is cut to the frame's shape instead (see posterFor).
  // Clips play in a plain <video>; long videos in Cloudflare Stream's adaptive iframe.
  // Deliberately no autoplay, muted or loop — it's an article, not a feed.
  function videoPlayer(b) {
    const v = parseVideoLink(b.link);
    if (!v) return '';
    if (v.kind === 'stream' && !v.src) {
      console.warn('Video block skipped: set STREAM_CUSTOMER_CODE in js/config.js to play Cloudflare Stream videos.');
      return '';
    }
    const aspect = aspectCss(b.aspect) || (v.short ? '9 / 16' : '16 / 9');
    const custom = posterFor(b.poster, aspect);
    const poster = custom || v.poster;
    const title = b.title?.trim();
    const caption = b.caption?.trim();
    let player;
    if (v.kind === 'file') {
      player = `<video controls playsinline preload="metadata" src="${esc(v.src)}" poster="${esc(poster)}"${title ? ` title="${esc(title)}"` : ''}></video>`;
    } else if (v.kind === 'youtube') {
      // Click-to-load: nothing from YouTube (script, cookies) loads until the reader
      // presses play; initVideo() swaps this button for the embed. The thumbnail comes
      // from YouTube's image CDN (i.ytimg.com), which sets no cookies.
      // Full-size 16:9 thumbnail (1280 × 720); initVideo() falls back to the 480 × 360 one,
      // which every video has, when YouTube has no full-size version.
      const label = `Play: ${title || 'video'}`;
      const thumb = custom || `https://i.ytimg.com/vi/${v.id}/maxresdefault.jpg`;
      player = `<button class="video-facade" type="button" data-yt="${esc(v.id)}" data-title="${esc(title || '')}" aria-label="${esc(label)}">`
        + `<img src="${esc(thumb)}"${custom ? '' : ` data-fallback="${esc(v.poster)}"`} alt="" loading="lazy" decoding="async" />`
        + `<span class="video-facade-play" aria-hidden="true">${ICON_PLAY}</span>`
        + `<span class="video-facade-source" aria-hidden="true">Plays from YouTube</span></button>`;
    } else {
      const src = custom ? `${v.src}&poster=${encodeURIComponent(custom)}` : v.src;
      player = `<iframe src="${esc(src)}" title="${esc(title || 'Video')}" loading="lazy"`
        + ` allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
    }
    const figcaption = title || caption
      ? `<figcaption>${title ? `<strong>${esc(title)}</strong>` : ''}${title && caption ? ' ' : ''}${caption ? esc(caption).replace(/\n/g, '<br />') : ''}</figcaption>`
      : '';
    // Portrait clips are capped by height on wide screens (see styles.css) instead of
    // filling the column as a tall black tower
    const [aw, ah] = aspect.split(' / ').map(Number);
    const portrait = ah > aw ? ' video--portrait' : '';
    return `
      <figure class="video video--${v.kind}${portrait}" style="--aspect: ${aspect}">
        <div class="video-frame">${player}</div>
        ${figcaption}
      </figure>`;
  }

  const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

  // The only YouTube URL the site ever loads: rebuilt from the id, never the stored link.
  // youtube-nocookie keeps cookies off until the reader interacts with the player.
  function youtubeEmbedSrc(id) {
    if (!YOUTUBE_ID_RE.test(id)) return null;
    return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&playsinline=1`;
  }

  // Swaps each YouTube facade for the real player when it is clicked.
  function initVideo(root = document) {
    // A missing full-size thumbnail comes back as YouTube's 120 × 90 grey placeholder
    root.querySelectorAll('.video-facade img[data-fallback]').forEach(img => {
      const fallback = () => {
        if (img.dataset.fallback && (!img.naturalWidth || img.naturalWidth <= 120)) {
          img.src = img.dataset.fallback;
          delete img.dataset.fallback;
        }
      };
      if (img.complete) fallback();
      img.addEventListener('load', fallback);
      img.addEventListener('error', fallback);
    });
    root.querySelectorAll('.video-facade[data-yt]').forEach(btn => {
      btn.addEventListener('click', () => {
        const src = youtubeEmbedSrc(btn.dataset.yt);
        if (!src) return;
        const iframe = document.createElement('iframe');
        iframe.src = src;
        iframe.title = btn.dataset.title || 'YouTube video';
        iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
        // YouTube refuses embeds that send no referrer (error 153)
        iframe.referrerPolicy = 'strict-origin-when-cross-origin';
        iframe.allowFullscreen = true;
        btn.replaceWith(iframe);
        iframe.focus();
      }, { once: true });
    });
  }

  // ---------- Portable Text → HTML ----------

  function blocksToText(blocks = []) {
    return blocks.map(b => (b._type === 'block' ? b.children.map(c => c.text).join('') : b.text || '')).join(' ');
  }

  function spans(block) {
    const defs = Object.fromEntries((block.markDefs || []).map(d => [d._key, d]));
    return (block.children || []).map(child => {
      let html = esc(child.text).replace(/\n/g, '<br />');
      for (const m of child.marks || []) {
        if (m === 'strong') html = `<strong>${html}</strong>`;
        else if (m === 'em') html = `<em>${html}</em>`;
        else if (m === 'code') html = `<code>${html}</code>`;
        else if (defs[m]?._type === 'link' && /^(https?:|mailto:|tel:|\/|#)/.test(defs[m].href || '')) {
          const ext = /^https?:/.test(defs[m].href) && !defs[m].href.includes('kedaipal.com');
          html = `<a href="${esc(defs[m].href)}"${ext ? ' target="_blank" rel="noopener"' : ''}>${html}</a>`;
        }
      }
      return html;
    }).join('');
  }

  function portableText(blocks = []) {
    let out = '', list = null;
    const closeList = () => { if (list) { out += `</${list}>`; list = null; } };
    for (const b of blocks) {
      if (b._type === 'block' && b.listItem) {
        const tag = b.listItem === 'number' ? 'ol' : 'ul';
        if (list !== tag) { closeList(); out += `<${tag}>`; list = tag; }
        out += `<li>${spans(b)}</li>`;
        continue;
      }
      closeList();
      if (b._type === 'block') {
        const tag = { h2: 'h2', h3: 'h3', blockquote: 'blockquote' }[b.style] || 'p';
        const inner = spans(b);
        if (inner.trim()) out += `<${tag}>${inner}</${tag}>`;
      } else if (b._type === 'image' && b.asset) {
        out += `<figure>${imgTag(b, 1344)}${b.caption ? `<figcaption>${esc(b.caption)}</figcaption>` : ''}</figure>`;
      } else if (b._type === 'callout') {
        out += `<div class="callout">${b.label ? `<strong>${esc(b.label)}:</strong> ` : ''}${esc(b.text)}</div>`;
      } else if (b._type === 'divider') {
        out += '<hr />';
      } else if (b._type === 'audio' && b.src) {
        out += audioPlayer(b);
      } else if (b._type === 'gallery' && b.images?.length) {
        out += gallery(b);
      } else if (b._type === 'video') {
        out += videoPlayer(b); // unknown link shapes render nothing
      }
    }
    closeList();
    return out;
  }

  return { live, getIndex, getPost, esc, formatDate, readTime, postUrl, cover, articleCover, avatar, card, portableText, parseVideoLink, videoPlayer, youtubeEmbedSrc, initAudio, initGallery, initVideo };
})();
