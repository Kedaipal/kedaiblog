#!/usr/bin/env node
/*
 * `npm run dev:offline` — the whole page on a laptop with NO accounts: no Clerk
 * sign-in, no Convex, no R2 bucket. For trying every state before anything is
 * set up, and for anyone without a dev Clerk login.
 *
 * It starts a tiny local server that plays two parts:
 *   - a Clerk-like issuer: /.well-known/jwks.json with a key generated now, and
 *     a token signed with it (the page receives it through /videos/config.js);
 *   - Convex: POST /api/query answering `adminAccess:mine`.
 * then runs `wrangler dev` pointed at it, with the local R2 simulator and
 * clips served from http://localhost:8787/videos/dev-media/….
 *
 * The Worker's real verification runs unchanged — only the issuer and the
 * access list are local. Production can't be affected: the token is signed by
 * a key that exists only in this process, and config.js only hands it out
 * while CLERK_ISSUER is on localhost.
 *
 * Options:
 *   --no-access       the access list says no → the "no admin access" page
 *   --convex-down     the access check fails → the "could not check" page
 *   --port=8787       the page's port (the mock uses port + 3)
 * Anything else is passed to `wrangler dev` (e.g. `--persist-to <dir>` for a
 * second instance beside a running one — two in the same folder share
 * .wrangler/state and crash each other).
 *
 * The YouTube link check still calls YouTube's public oEmbed, so it needs
 * internet; everything else is offline.
 */
import {spawn} from 'node:child_process'
import {createServer} from 'node:http'
import {generateKeyPairSync, createSign, randomUUID} from 'node:crypto'

const OWN = /^--(no-access|convex-down|port=\d+)$/
const argv = process.argv.slice(2)
const args = new Set(argv.filter((a) => OWN.test(a)))
const passThrough = argv.filter((a) => !OWN.test(a))
const portArg = [...args].find((a) => a.startsWith('--port='))
const PORT = portArg ? Number(portArg.split('=')[1]) : 8787
const MOCK_PORT = PORT + 3
const ISSUER = `http://localhost:${MOCK_PORT}`
const ORIGIN = `http://localhost:${PORT}`
const SUB = 'user_offline_tester'

const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048})
const kid = `offline_${randomUUID().slice(0, 8)}`
const jwk = {...publicKey.export({format: 'jwk'}), kid, alg: 'RS256', use: 'sig'}

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url')
function mintToken() {
  const now = Math.floor(Date.now() / 1000)
  const head = b64url({alg: 'RS256', kid, typ: 'JWT'})
  const body = b64url({iss: ISSUER, sub: SUB, aud: 'convex', azp: ORIGIN, iat: now, nbf: now - 5, exp: now + 12 * 3600})
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url')
  return `${head}.${body}.${sig}`
}

const areas = args.has('--no-access') ? [] : ['videos']
const server = createServer((req, res) => {
  if (req.url === '/.well-known/jwks.json') {
    res.writeHead(200, {'content-type': 'application/json'})
    return res.end(JSON.stringify({keys: [jwk]}))
  }
  if (req.url === '/api/query' && req.method === 'POST') {
    if (args.has('--convex-down')) {
      res.writeHead(500, {'content-type': 'application/json'})
      return res.end(JSON.stringify({status: 'error', errorMessage: 'offline mock: Convex is down'}))
    }
    res.writeHead(200, {'content-type': 'application/json'})
    return res.end(JSON.stringify({status: 'success', value: {areas}}))
  }
  res.writeHead(404).end()
})

server.listen(MOCK_PORT, 'localhost', () => {
  const token = mintToken()
  console.log(`\n  Offline mock (login + access list) on ${ISSUER} — access: ${areas.length ? 'videos' : 'none'}${args.has('--convex-down') ? ' (Convex down)' : ''}`)
  console.log(`  Open ${ORIGIN}/videos\n`)
  const vars = {
    CLERK_PUBLISHABLE_KEY: 'offline',
    CLERK_ISSUER: ISSUER,
    CLERK_AUTHORIZED_PARTIES: ORIGIN,
    CONVEX_URL: ISSUER,
    APP_URL: 'http://localhost:3000/app',
    PUBLIC_MEDIA_BASE: `${ORIGIN}/videos/dev-media`,
    SERVE_MEDIA: '1',
    DEV_OFFLINE_TOKEN: token,
  }
  const wranglerArgs = ['wrangler', 'dev', '--port', String(PORT), ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`]), ...passThrough]
  const child = spawn('npx', wranglerArgs, {stdio: 'inherit'})
  const stop = () => {
    child.kill('SIGINT')
    server.close()
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  child.on('exit', (code) => {
    server.close()
    process.exit(code ?? 0)
  })
})
