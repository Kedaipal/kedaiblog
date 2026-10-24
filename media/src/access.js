/*
 * Cloudflare Access JWT verification.
 *
 * Access sits in front of upload.kedaipal.com and, once a writer has entered
 * their email code, adds a signed JWT to every request as the
 * `Cf-Access-Jwt-Assertion` header (and the `CF_Authorization` cookie). Access
 * is the login UI; THIS check is the lock. Without it the Worker would be open
 * to anyone who reaches it by another hostname.
 *
 * Verification: RS256 signature against the team's published keys
 * (https://<team>.cloudflareaccess.com/cdn-cgi/access/certs), `iss` must be the
 * team, `aud` must contain this application's AUD tag, and the token must be
 * within its `nbf`/`exp` window. Nothing else from the request is trusted —
 * not even `Cf-Access-Authenticated-User-Email`, which is only a header.
 *
 * `verifyAccessJwt` is pure apart from `fetchJwks`, which is injected so the
 * tests can hand it a key set they generated themselves.
 */

const TEXT = new TextEncoder()
const CLOCK_SKEW_SECONDS = 60

export class AccessError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function base64UrlToBytes(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) throw new AccessError('malformed', 'bad base64url')
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function decodeJson(segment) {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)))
  } catch {
    throw new AccessError('malformed', 'JWT segment is not valid JSON')
  }
}

/** Pull the token out of the request: header first, cookie as a fallback. */
export function tokenFromRequest(request) {
  const header = request.headers.get('Cf-Access-Jwt-Assertion')
  if (header) return header.trim()
  const cookie = request.headers.get('Cookie') || ''
  const m = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/)
  return m ? m[1].trim() : null
}

/**
 * Fetch the team's JWKS. Cached in the isolate for an hour, and at the edge via
 * `cf.cacheTtl`, so a verification costs no network round trip in steady state.
 */
const jwksCache = new Map() // teamDomain -> {keys, fetchedAt}
export async function fetchTeamJwks(teamDomain, {force = false} = {}) {
  const cached = jwksCache.get(teamDomain)
  if (!force && cached && Date.now() - cached.fetchedAt < 60 * 60 * 1000) return cached.keys
  const url = `https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`
  const res = await fetch(url, {cf: {cacheTtl: 3600, cacheEverything: true}})
  if (!res.ok) throw new AccessError('jwks', `JWKS fetch failed: ${res.status}`)
  const body = await res.json()
  const keys = Array.isArray(body?.keys) ? body.keys : []
  jwksCache.set(teamDomain, {keys, fetchedAt: Date.now()})
  return keys
}

/**
 * Verify a Cloudflare Access JWT.
 * @param {string} token
 * @param {object} opts
 * @param {string} opts.teamDomain  e.g. "kedaipal" for kedaipal.cloudflareaccess.com
 * @param {string} opts.aud         the Access application's AUD tag
 * @param {(team: string, o?: {force?: boolean}) => Promise<object[]>} [opts.fetchJwks]
 * @param {number} [opts.now]       seconds since epoch (tests)
 * @returns {Promise<object>} the verified claims (email, sub, aud, exp, …)
 * @throws {AccessError} with .code in: malformed, alg, kid, signature, iss, aud, exp, nbf
 */
export async function verifyAccessJwt(token, {teamDomain, aud, fetchJwks = fetchTeamJwks, now} = {}) {
  if (!teamDomain || !aud) throw new AccessError('config', 'ACCESS_TEAM_DOMAIN / ACCESS_AUD not set')
  if (typeof token !== 'string') throw new AccessError('malformed', 'no token')
  const parts = token.split('.')
  if (parts.length !== 3 || !parts[2]) throw new AccessError('malformed', 'JWT must have three signed parts')

  const header = decodeJson(parts[0])
  if (header.alg !== 'RS256') throw new AccessError('alg', `unsupported alg ${header.alg}`)
  if (typeof header.kid !== 'string') throw new AccessError('kid', 'JWT has no kid')

  // Find the signing key, refreshing once if the kid is unknown (key rotation).
  let keys = await fetchJwks(teamDomain)
  let jwk = keys.find((k) => k.kid === header.kid)
  if (!jwk) {
    keys = await fetchJwks(teamDomain, {force: true})
    jwk = keys.find((k) => k.kid === header.kid)
  }
  if (!jwk) throw new AccessError('kid', 'JWT signed by an unknown key')
  if (jwk.kty !== 'RSA') throw new AccessError('alg', 'JWK is not an RSA key')

  const key = await crypto.subtle.importKey(
    'jwk',
    {kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true},
    {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'},
    false,
    ['verify'],
  )
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64UrlToBytes(parts[2]),
    TEXT.encode(`${parts[0]}.${parts[1]}`),
  )
  if (!ok) throw new AccessError('signature', 'JWT signature does not verify')

  const claims = decodeJson(parts[1])
  const t = now ?? Math.floor(Date.now() / 1000)
  const issuer = `https://${teamDomain}.cloudflareaccess.com`
  if (claims.iss !== issuer) throw new AccessError('iss', `issuer ${claims.iss} is not ${issuer}`)
  const audList = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!audList.includes(aud)) throw new AccessError('aud', 'JWT is for a different application')
  if (typeof claims.exp !== 'number' || claims.exp <= t - CLOCK_SKEW_SECONDS) throw new AccessError('exp', 'JWT has expired')
  if (typeof claims.nbf === 'number' && claims.nbf > t + CLOCK_SKEW_SECONDS) throw new AccessError('nbf', 'JWT not yet valid')
  return claims
}
