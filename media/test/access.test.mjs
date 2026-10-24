import assert from 'node:assert/strict'
import {before, describe, it} from 'node:test'
import {AccessError, tokenFromRequest, verifyAccessJwt} from '../src/access.js'

const TEAM = 'kedaipal'
const AUD = 'aud-for-upload-kedaipal-com'
const NOW = 1_800_000_000 // fixed "now" (seconds) so the tests never age

const b64url = (input) => Buffer.from(typeof input === 'string' ? input : JSON.stringify(input)).toString('base64url')

let keys // {kid, privateKey, jwk}[]
let fetchJwks

async function makeKey(kid) {
  const pair = await crypto.subtle.generateKey({name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256'}, true, ['sign', 'verify'])
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  return {kid, privateKey: pair.privateKey, jwk: {kid, kty: 'RSA', alg: 'RS256', use: 'sig', n: jwk.n, e: jwk.e}}
}

async function sign({kid = keys[0].kid, privateKey = keys[0].privateKey, header = {}, claims = {}} = {}) {
  const h = b64url({alg: 'RS256', kid, typ: 'JWT', ...header})
  const p = b64url({
    iss: `https://${TEAM}.cloudflareaccess.com`,
    aud: [AUD],
    email: 'kris@example.com',
    sub: 'user-1',
    iat: NOW - 60,
    nbf: NOW - 60,
    exp: NOW + 3600,
    ...claims,
  })
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(`${h}.${p}`))
  return `${h}.${p}.${Buffer.from(sig).toString('base64url')}`
}

const verify = (token, extra = {}) => verifyAccessJwt(token, {teamDomain: TEAM, aud: AUD, fetchJwks, now: NOW, ...extra})

async function rejectsWith(code, promise) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof AccessError, `expected AccessError, got ${err?.constructor?.name}: ${err?.message}`)
    assert.equal(err.code, code, `expected code "${code}", got "${err.code}" (${err.message})`)
    return true
  })
}

before(async () => {
  keys = [await makeKey('key-1'), await makeKey('key-2')]
  fetchJwks = async () => keys.map((k) => k.jwk)
})

describe('verifyAccessJwt', () => {
  it('accepts a token signed by the team for this application', async () => {
    const claims = await verify(await sign())
    assert.equal(claims.email, 'kris@example.com')
    assert.deepEqual(claims.aud, [AUD])
  })
  it('accepts a token signed by the second published key (rotation)', async () => {
    const claims = await verify(await sign({kid: keys[1].kid, privateKey: keys[1].privateKey}))
    assert.equal(claims.sub, 'user-1')
  })
  it('accepts aud as a bare string too', async () => {
    await verify(await sign({claims: {aud: AUD}}))
  })

  it('rejects a bad aud (token for another Access application)', async () => {
    await rejectsWith('aud', verify(await sign({claims: {aud: ['some-other-app']}})))
  })
  it('rejects an expired token', async () => {
    await rejectsWith('exp', verify(await sign({claims: {exp: NOW - 3600}})))
  })
  it('rejects an unsigned token (alg none)', async () => {
    const h = b64url({alg: 'none', kid: 'key-1'})
    const p = b64url({iss: `https://${TEAM}.cloudflareaccess.com`, aud: [AUD], exp: NOW + 3600})
    await rejectsWith('alg', verify(`${h}.${p}.${b64url('not-a-signature')}`))
    // An empty or missing signature segment never even reaches the alg check.
    await rejectsWith('malformed', verify(`${h}.${p}.`))
    await rejectsWith('malformed', verify(`${h}.${p}`))
  })
  it('rejects a token signed by a key the team never published', async () => {
    const rogue = await makeKey('key-1') // same kid, different key
    await rejectsWith('signature', verify(await sign({privateKey: rogue.privateKey})))
  })
  it('rejects an unknown kid even after refreshing the key set', async () => {
    let calls = 0
    const counting = async () => (calls++, keys.map((k) => k.jwk))
    await rejectsWith('kid', verify(await sign({kid: 'key-9'}), {fetchJwks: counting}))
    assert.equal(calls, 2, 'should refetch once for an unknown kid')
  })
  it('rejects a tampered payload', async () => {
    const token = await sign()
    const [h, , s] = token.split('.')
    const forged = b64url({iss: `https://${TEAM}.cloudflareaccess.com`, aud: [AUD], exp: NOW + 3600, email: 'attacker@example.com'})
    await rejectsWith('signature', verify(`${h}.${forged}.${s}`))
  })
  it('rejects another team as issuer', async () => {
    await rejectsWith('iss', verify(await sign({claims: {iss: 'https://evil.cloudflareaccess.com'}})))
  })
  it('rejects a token that is not yet valid', async () => {
    await rejectsWith('nbf', verify(await sign({claims: {nbf: NOW + 600}})))
  })
  it('rejects missing / junk tokens', async () => {
    await rejectsWith('malformed', verify(null))
    await rejectsWith('malformed', verify('not.a.jwt'))
    await rejectsWith('malformed', verify(''))
  })
  it('fails closed when the Worker is not configured', async () => {
    await rejectsWith('config', verifyAccessJwt(await sign(), {teamDomain: '', aud: AUD, fetchJwks, now: NOW}))
  })
})

describe('tokenFromRequest', () => {
  it('prefers the header, falls back to the CF_Authorization cookie', () => {
    assert.equal(tokenFromRequest(new Request('https://u.test/', {headers: {'Cf-Access-Jwt-Assertion': 'abc'}})), 'abc')
    assert.equal(tokenFromRequest(new Request('https://u.test/', {headers: {Cookie: 'x=1; CF_Authorization=def; y=2'}})), 'def')
    assert.equal(tokenFromRequest(new Request('https://u.test/')), null)
  })
})
