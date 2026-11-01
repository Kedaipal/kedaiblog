/* Test helpers: an RSA key set and a Clerk-shaped token signer. */
export const ISSUER = 'https://clerk.example.test'
export const ADMIN_ORIGIN = 'https://admin.kedaipal.com'
export const NOW = 1_800_000_000

export const b64url = (input) => Buffer.from(typeof input === 'string' ? input : JSON.stringify(input)).toString('base64url')

export async function makeKey(kid) {
  const pair = await crypto.subtle.generateKey({name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256'}, true, ['sign', 'verify'])
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  return {kid, privateKey: pair.privateKey, jwk: {kid, kty: 'RSA', alg: 'RS256', use: 'sig', n: jwk.n, e: jwk.e}}
}

/** A token shaped like Clerk's `convex` JWT template output. */
export async function signToken(key, {header = {}, claims = {}, now = NOW} = {}) {
  const h = b64url({alg: 'RS256', kid: key.kid, typ: 'JWT', ...header})
  const p = b64url({iss: ISSUER, aud: 'convex', azp: ADMIN_ORIGIN, sub: 'user_writer', iat: now - 10, nbf: now - 10, exp: now + 60, ...claims})
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, new TextEncoder().encode(`${h}.${p}`))
  return `${h}.${p}.${Buffer.from(sig).toString('base64url')}`
}
