import assert from 'node:assert/strict'
import {before, describe, it} from 'node:test'
import {AuthError, bearerToken, parseList, verifyClerkToken} from '../src/clerk.js'
import {ADMIN_ORIGIN, ISSUER, NOW, b64url, makeKey, signToken} from './helpers.mjs'

let keys, fetchJwks
before(async () => {
  keys = [await makeKey('ins_1'), await makeKey('ins_2')]
  fetchJwks = async () => keys.map((k) => k.jwk)
})
const verify = (token, extra = {}) => verifyClerkToken(token, {issuer: ISSUER, authorizedParties: [ADMIN_ORIGIN], fetchJwks, now: NOW, ...extra})
async function rejectsWith(code, promise) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof AuthError, `expected AuthError, got ${err?.constructor?.name}: ${err?.message}`)
    assert.equal(err.code, code, `expected "${code}", got "${err.code}" (${err.message})`)
    return true
  })
}

describe('verifyClerkToken', () => {
  it('accepts a convex-template token minted for admin.kedaipal.com', async () => {
    const claims = await verify(await signToken(keys[0]))
    assert.equal(claims.sub, 'user_writer')
  })
  it('accepts the second published key (rotation) and an array aud', async () => {
    await verify(await signToken(keys[1], {claims: {aud: ['convex', 'x']}}))
  })
  it('rejects a token minted for another origin (azp) — e.g. a token lifted from the app', async () => {
    await rejectsWith('azp', verify(await signToken(keys[0], {claims: {azp: 'https://kedaipal.com'}})))
    await rejectsWith('azp', verify(await signToken(keys[0], {claims: {azp: undefined}})))
  })
  it('rejects the plain session token (no convex aud)', async () => {
    await rejectsWith('aud', verify(await signToken(keys[0], {claims: {aud: undefined}})))
  })
  it('rejects an expired token', async () => {
    await rejectsWith('exp', verify(await signToken(keys[0], {claims: {exp: NOW - 120}})))
  })
  it('rejects a token from another Clerk instance', async () => {
    await rejectsWith('iss', verify(await signToken(keys[0], {claims: {iss: 'https://evil.clerk.accounts.dev'}})))
  })
  it('rejects unsigned (alg none) and missing signatures', async () => {
    const h = b64url({alg: 'none', kid: 'ins_1'})
    const p = b64url({iss: ISSUER, aud: 'convex', azp: ADMIN_ORIGIN, sub: 'u', exp: NOW + 60})
    await rejectsWith('alg', verify(`${h}.${p}.${b64url('x')}`))
    await rejectsWith('malformed', verify(`${h}.${p}.`))
    await rejectsWith('malformed', verify(`${h}.${p}`))
  })
  it('rejects a token signed by a key the instance never published', async () => {
    const rogue = await makeKey('ins_1')
    await rejectsWith('signature', verify(await signToken(rogue)))
  })
  it('rejects a tampered payload', async () => {
    const [h, , s] = (await signToken(keys[0])).split('.')
    const forged = b64url({iss: ISSUER, aud: 'convex', azp: ADMIN_ORIGIN, sub: 'user_superadmin', exp: NOW + 60})
    await rejectsWith('signature', verify(`${h}.${forged}.${s}`))
  })
  it('refetches once for an unknown kid, then rejects', async () => {
    let calls = 0
    await rejectsWith('kid', verify(await signToken({...keys[0], kid: 'ins_9'}), {fetchJwks: async () => (calls++, keys.map((k) => k.jwk))}))
    assert.equal(calls, 2)
  })
  it('rejects not-yet-valid tokens and tokens without a user', async () => {
    await rejectsWith('nbf', verify(await signToken(keys[0], {claims: {nbf: NOW + 600}})))
    await rejectsWith('sub', verify(await signToken(keys[0], {claims: {sub: ''}})))
  })
  it('fails closed when not configured', async () => {
    await rejectsWith('config', verify(await signToken(keys[0]), {issuer: ''}))
    await rejectsWith('config', verify(await signToken(keys[0]), {authorizedParties: []}))
  })
})

describe('helpers', () => {
  it('bearerToken reads only a Bearer Authorization header', () => {
    assert.equal(bearerToken(new Request('https://a.test', {headers: {Authorization: 'Bearer abc.def.ghi'}})), 'abc.def.ghi')
    assert.equal(bearerToken(new Request('https://a.test', {headers: {Authorization: 'Basic xyz'}})), null)
    assert.equal(bearerToken(new Request('https://a.test')), null)
  })
  it('parseList trims and drops trailing slashes', () => {
    assert.deepEqual(parseList(' https://admin.kedaipal.com/ , http://localhost:8787'), ['https://admin.kedaipal.com', 'http://localhost:8787'])
    assert.deepEqual(parseList(''), [])
  })
})
