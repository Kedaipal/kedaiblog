/*
 * Clerk session-token verification, done locally in the Worker.
 *
 * The page signs in with the Kedaipal app's own Clerk instance (production:
 * Frontend API https://clerk.kedaipal.com), then sends every API call a token
 * from the `convex` JWT template — the same template the app uses for Convex,
 * so the Worker can pass it straight on to Convex for the access check.
 *
 * Checked here, before anything else happens: RS256 signature against the
 * instance's JWKS (<issuer>/.well-known/jwks.json), `iss` = CLERK_ISSUER,
 * `exp`/`nbf`, `azp` (the origin the token was minted for) in the allowed
 * list, and `aud` = "convex". Never trust the client.
 *
 * `fetchJwks` is injectable so the tests can use a key set they generated.
 */

const TEXT = new TextEncoder()
const CLOCK_SKEW_SECONDS = 30

export class AuthError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function base64UrlToBytes(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) throw new AuthError('malformed', 'bad base64url')
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
    throw new AuthError('malformed', 'JWT segment is not valid JSON')
  }
}

/** `Authorization: Bearer <token>` → token, else null. */
export function bearerToken(request) {
  const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization') || '')
  return m ? m[1] : null
}

/** JWKS cached in the isolate for an hour and at the edge via cf.cacheTtl. */
const jwksCache = new Map() // issuer -> {keys, fetchedAt}
export async function fetchIssuerJwks(issuer, {force = false} = {}) {
  const cached = jwksCache.get(issuer)
  if (!force && cached && Date.now() - cached.fetchedAt < 60 * 60 * 1000) return cached.keys
  const res = await fetch(`${issuer}/.well-known/jwks.json`, {cf: {cacheTtl: 3600, cacheEverything: true}})
  if (!res.ok) throw new AuthError('jwks', `JWKS fetch failed: ${res.status}`)
  const body = await res.json()
  const keys = Array.isArray(body?.keys) ? body.keys : []
  jwksCache.set(issuer, {keys, fetchedAt: Date.now()})
  return keys
}

/** "https://a, https://b" → ["https://a", "https://b"] */
export function parseList(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean)
}

/**
 * @param {string} token
 * @param {object} o
 * @param {string} o.issuer               e.g. https://clerk.kedaipal.com
 * @param {string[]} o.authorizedParties  allowed `azp` origins
 * @param {string} [o.audience]           required `aud` (default "convex")
 * @param {Function} [o.fetchJwks]
 * @param {number} [o.now]                seconds since epoch (tests)
 * @returns {Promise<object>} verified claims (`sub` is the Clerk user id)
 * @throws {AuthError} code in: config, malformed, alg, kid, signature, iss, azp, aud, exp, nbf, sub
 */
export async function verifyClerkToken(token, {issuer, authorizedParties, audience = 'convex', fetchJwks = fetchIssuerJwks, now} = {}) {
  if (!issuer || !authorizedParties?.length) throw new AuthError('config', 'CLERK_ISSUER / CLERK_AUTHORIZED_PARTIES not set')
  if (typeof token !== 'string') throw new AuthError('malformed', 'no token')
  const parts = token.split('.')
  if (parts.length !== 3 || !parts[2]) throw new AuthError('malformed', 'JWT must have three signed parts')

  const header = decodeJson(parts[0])
  if (header.alg !== 'RS256') throw new AuthError('alg', `unsupported alg ${header.alg}`)
  if (typeof header.kid !== 'string') throw new AuthError('kid', 'JWT has no kid')

  let keys = await fetchJwks(issuer)
  let jwk = keys.find((k) => k.kid === header.kid)
  if (!jwk) {
    keys = await fetchJwks(issuer, {force: true}) // key rotation
    jwk = keys.find((k) => k.kid === header.kid)
  }
  if (!jwk) throw new AuthError('kid', 'JWT signed by an unknown key')
  if (jwk.kty !== 'RSA') throw new AuthError('alg', 'JWK is not an RSA key')

  const key = await crypto.subtle.importKey(
    'jwk',
    {kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true},
    {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'},
    false,
    ['verify'],
  )
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64UrlToBytes(parts[2]), TEXT.encode(`${parts[0]}.${parts[1]}`))
  if (!ok) throw new AuthError('signature', 'JWT signature does not verify')

  const claims = decodeJson(parts[1])
  const t = now ?? Math.floor(Date.now() / 1000)
  if (claims.iss !== issuer) throw new AuthError('iss', `issuer ${claims.iss} is not ${issuer}`)
  if (typeof claims.exp !== 'number' || claims.exp <= t - CLOCK_SKEW_SECONDS) throw new AuthError('exp', 'token has expired')
  if (typeof claims.nbf === 'number' && claims.nbf > t + CLOCK_SKEW_SECONDS) throw new AuthError('nbf', 'token not yet valid')
  if (!authorizedParties.includes(String(claims.azp || '').replace(/\/+$/, ''))) throw new AuthError('azp', `token was issued for ${claims.azp || 'no origin'}`)
  if (audience) {
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (!aud.includes(audience)) throw new AuthError('aud', `token is not for "${audience}"`)
  }
  if (typeof claims.sub !== 'string' || !claims.sub) throw new AuthError('sub', 'token has no user')
  return claims
}
