import {Fragment, useEffect, useRef, useState} from 'react'
import {Badge, Box, Card, Flex, Stack, Text} from '@sanity/ui'
import {MemberField, set, unset} from 'sanity'
import {VideoIcon} from '@sanity/icons/Video'

/*
 * The Video block: one "Video link" field that works out which player the site uses.
 *   Clip (≤ 5 min, uploaded at admin.kedaipal.com/videos, stored on R2):
 *           https://media.kedaipal.com/videos/<folder>/<name>.mp4
 *   YouTube (long videos, on the Kedaipal channel): watch?v=, youtu.be/, /shorts/, /live/,
 *           /embed/, m.youtube.com, youtube-nocookie embed. Same regex as the admin page's
 *           media/public/videos/lib/youtube.js.
 *   Stream (dormant, no account): …cloudflarestream.com/<uid>/iframe|watch, or a bare uid.
 *
 * The regexes below are copied VERBATIM from js/sanity.js (parseVideoLink), so the Studio
 * refuses exactly the links the site would skip. Change them in every file together; a
 * test fails if they drift.
 */
const VIDEO_FILE_RE = /^https:\/\/media\.kedaipal\.com\/videos\/([A-Za-z0-9_-]+)\/([A-Za-z0-9][A-Za-z0-9._-]*\.mp4)$/;
const VIDEO_YOUTUBE_RE = /^https:\/\/(?:(?:www\.|m\.)?youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/|www\.youtube-nocookie\.com\/embed\/)([A-Za-z0-9_-]{11})(?=$|[?&#/])\S*$/;
const VIDEO_STREAM_RE = /^(?:https:\/\/(customer-[a-z0-9]+)\.cloudflarestream\.com\/([0-9a-f]{32})\/(?:iframe|watch)\/?(?:\?[^\s#]*)?|([0-9a-f]{32}))$/;

export const BAD_LINK_MESSAGE =
  "That's not a link we can play. Upload a clip at admin.kedaipal.com/videos, or paste the link of a video on our YouTube channel."

// Studio-side twin of parseVideoLink in js/sanity.js. The Stream thumbnail here uses the
// customer code from the pasted link — preview only; the site uses STREAM_CUSTOMER_CODE.
export function parseVideoLink(link) {
  const s = String(link ?? '').trim()
  let m = VIDEO_FILE_RE.exec(s)
  if (m) return {kind: 'file', src: s, poster: s.replace(/\.mp4$/, '.jpg'), name: m[2]}
  m = VIDEO_YOUTUBE_RE.exec(s)
  if (m) return {kind: 'youtube', id: m[1], short: /\/shorts\//.test(s), poster: `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg`}
  m = VIDEO_STREAM_RE.exec(s)
  if (m) {
    const uid = m[2] || m[3]
    const host = m[1] ? `https://${m[1]}.cloudflarestream.com` : null
    return {kind: 'stream', uid, poster: host ? `${host}/${uid}/thumbnails/thumbnail.jpg` : null}
  }
  return null
}

// 1920 × 1080 → "16/9": the string the site puts into CSS aspect-ratio
export function aspectString(w, h) {
  const gcd = (a, b) => (b ? gcd(b, a % b) : a)
  const g = gcd(w, h) || 1
  return `${w / g}/${h / g}`
}

const KIND = {
  file: {label: 'Clip', detail: 'stored on media.kedaipal.com', tone: 'positive'},
  youtube: {label: 'YouTube', detail: 'plays from our YouTube channel', tone: 'primary'},
  stream: {label: 'Stream', detail: 'not set up — won’t show on the site', tone: 'caution'},
}

const idOf = (v) => (v.kind === 'file' ? v.name : v.kind === 'youtube' ? v.id : v.uid)

// Used by the block's preview in post.js (title row in the body editor)
export function videoPreview({title, link, poster}) {
  const v = parseVideoLink(link)
  const subtitle = v
    ? `${KIND[v.kind].label}${v.short ? ' Short' : ''} · ${idOf(v)}`
    : link
      ? 'Not a link we can play'
      : 'Paste a clip link or a YouTube link'
  const media = poster?.asset
    ? poster
    : v?.poster
      ? <img src={v.poster} alt="" style={{width: '100%', height: '100%', objectFit: 'cover'}} />
      : VideoIcon
  return {title: title || 'Video', subtitle, media}
}

const clock = (t) =>
  Number.isFinite(t) ? `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}` : ''

function Thumb({src, kind}) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [src])
  return (
    <Box
      style={{
        position: 'relative',
        flex: '0 0 11rem',
        aspectRatio: '16 / 9',
        borderRadius: 4,
        overflow: 'hidden',
        background: '#0f1729',
        display: 'grid',
        placeItems: 'center',
        color: 'rgba(255,255,255,.55)',
      }}
    >
      {src && !failed ? (
        <img
          src={src}
          alt=""
          onError={() => setFailed(true)}
          style={{position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover'}}
        />
      ) : (
        <Stack space={2} style={{textAlign: 'center', padding: '0 .75rem'}}>
          <Text size={3} style={{color: 'inherit'}}>
            <VideoIcon />
          </Text>
          <Text size={0} style={{color: 'inherit'}}>
            {src ? (kind === 'youtube' ? 'Thumbnail unavailable' : 'Poster not ready yet') : 'No preview'}
          </Text>
        </Stack>
      )}
    </Box>
  )
}

// Badge + thumbnail + what the site will reserve, shown right under the link field
function LinkStatus({parsed, probe}) {
  const kind = KIND[parsed.kind]
  const detail =
    parsed.kind === 'youtube'
      ? `${parsed.short ? 'Vertical Short, shown 9:16' : 'Shown 16:9'}. Nothing loads from YouTube until the reader presses play · video ${parsed.id}`
      : parsed.kind === 'stream'
        ? 'Cloudflare Stream isn’t set up, so the site skips this video. Upload a clip at admin.kedaipal.com/videos or use a YouTube link instead.'
        : probe.state === 'loading'
        ? 'Reading the clip’s size…'
        : probe.state === 'ok'
          ? `${probe.width} × ${probe.height} · ${probe.aspect.replace('/', ':')}${probe.duration ? ` · ${clock(probe.duration)}` : ''}`
          : 'Couldn’t read the clip yet (is the link live?). The page will use a 16:9 box until it can.'
  return (
    <Card padding={3} radius={2} border tone="transparent">
      <Flex gap={3} align="flex-start">
        <Thumb src={parsed.poster} kind={parsed.kind} />
        <Stack space={3} style={{flex: 1, minWidth: 0, paddingTop: '.125rem'}}>
          <Flex gap={2} align="center" wrap="wrap">
            <Badge tone={kind.tone} fontSize={1} padding={2}>
              {kind.label}
            </Badge>
            <Text size={1} muted>
              {kind.detail}
            </Text>
          </Flex>
          <Text size={1} muted style={{overflowWrap: 'anywhere'}}>
            {detail}
          </Text>
        </Stack>
      </Flex>
    </Card>
  )
}

/*
 * Input for the whole Video object (not just the link field): the status card sits
 * under the link, and only an object-level input can write the sibling `aspect`
 * field. Fields render exactly as Sanity would, via MemberField.
 */
export function VideoLinkInput(props) {
  const {value, onChange, members} = props
  const link = value?.link
  const parsed = parseVideoLink(link)
  const [probe, setProbe] = useState({state: 'idle'})
  const current = useRef(value)
  current.current = value

  // Fill the hidden `aspect` field so the page can reserve the right box.
  // Clip: read the real size from the file's metadata (a <video preload="metadata">
  // needs no CORS). YouTube: 16:9, or 9:16 for a Short. Stream: 16:9.
  const key = parsed ? `${parsed.kind}:${parsed.kind === 'file' ? parsed.src : idOf(parsed)}` : ''
  useEffect(() => {
    const write = (aspect) => {
      if ((current.current?.aspect || null) !== aspect) onChange(aspect ? set(aspect, ['aspect']) : unset(['aspect']))
    }
    if (!parsed) {
      setProbe({state: 'idle'})
      if (current.current?.aspect) write(null)
      return
    }
    if (parsed.kind !== 'file') {
      setProbe({state: 'idle'})
      write(parsed.short ? '9/16' : '16/9')
      return
    }
    setProbe({state: 'loading'})
    let active = true
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.onloadedmetadata = () => {
      if (!active) return
      const aspect = aspectString(video.videoWidth, video.videoHeight)
      setProbe({state: 'ok', width: video.videoWidth, height: video.videoHeight, aspect, duration: video.duration})
      write(aspect)
    }
    video.onerror = () => {
      if (!active) return
      setProbe({state: 'error'})
      write(null)
    }
    video.src = parsed.src
    return () => {
      active = false
      video.removeAttribute('src')
      video.load()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return (
    <Stack space={4}>
      {members.map((member) =>
        member.kind === 'field' ? (
          <Fragment key={member.key}>
            <MemberField
              member={member}
              renderInput={props.renderInput}
              renderField={props.renderField}
              renderItem={props.renderItem}
              renderPreview={props.renderPreview}
            />
            {member.name === 'link' && parsed && <LinkStatus parsed={parsed} probe={probe} />}
          </Fragment>
        ) : null,
      )}
    </Stack>
  )
}
