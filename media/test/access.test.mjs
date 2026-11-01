import assert from 'node:assert/strict'
import {beforeEach, describe, it} from 'node:test'
import {ACCESS_QUERY, AccessUnavailable, adminAccess, clearAccessCache} from '../src/access.js'

const CONVEX = 'https://dev-deployment.convex.cloud'
beforeEach(() => clearAccessCache())

function convexStub(reply) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({url, init})
    return typeof reply === 'function' ? reply(url, init) : Response.json(reply)
  }
  return {calls, fetchImpl}
}

describe('adminAreas — the one access list in Convex', () => {
  it('calls the query over HTTP with the caller’s own token', async () => {
    const {calls, fetchImpl} = convexStub({status: 'success', value: {areas: ['videos'], hasStore: true}})
    assert.deepEqual(await adminAccess({convexUrl: CONVEX, token: 'tok', sub: 'u1', fetchImpl}), {areas: ['videos'], hasStore: true})
    assert.equal(calls[0].url, `${CONVEX}/api/query`)
    assert.equal(calls[0].init.headers.authorization, 'Bearer tok')
    assert.deepEqual(JSON.parse(calls[0].init.body), {path: ACCESS_QUERY, args: {}, format: 'json'})
  })
  it('returns no areas for someone who is not on any list', async () => {
    const {fetchImpl} = convexStub({status: 'success', value: {areas: [], hasStore: false}})
    assert.deepEqual(await adminAccess({convexUrl: CONVEX, token: 't', sub: 'u2', fetchImpl}), {areas: [], hasStore: false})
  })
  it('caches per user for a minute', async () => {
    const {calls, fetchImpl} = convexStub({status: 'success', value: {areas: ['videos']}})
    await adminAccess({convexUrl: CONVEX, token: 't', sub: 'u3', fetchImpl, now: 0})
    await adminAccess({convexUrl: CONVEX, token: 't', sub: 'u3', fetchImpl, now: 59_000})
    assert.equal(calls.length, 1)
    await adminAccess({convexUrl: CONVEX, token: 't', sub: 'u3', fetchImpl, now: 61_000})
    assert.equal(calls.length, 2)
    await adminAccess({convexUrl: CONVEX, token: 't', sub: 'someone-else', fetchImpl, now: 61_000})
    assert.equal(calls.length, 3)
  })
  it('a missing query or Convex error is "unavailable", never "allowed"', async () => {
    const missing = convexStub(() => Response.json({status: 'error', errorMessage: 'Could not find public function for \'adminAccess:mine\''}, {status: 400}))
    await assert.rejects(adminAccess({convexUrl: CONVEX, token: 't', sub: 'u4', fetchImpl: missing.fetchImpl}), AccessUnavailable)
    const down = convexStub(() => {
      throw new TypeError('fetch failed')
    })
    await assert.rejects(adminAccess({convexUrl: CONVEX, token: 't', sub: 'u5', fetchImpl: down.fetchImpl}), AccessUnavailable)
  })
  it('ignores junk in the reply', async () => {
    const {fetchImpl} = convexStub({status: 'success', value: {areas: ['videos', 7, null], hasStore: 'yes'}})
    assert.deepEqual(await adminAccess({convexUrl: CONVEX, token: 't', sub: 'u6', fetchImpl}), {areas: ['videos'], hasStore: false})
  })
  it('an older Convex without hasStore counts as no store', async () => {
    const {fetchImpl} = convexStub({status: 'success', value: {areas: ['videos']}})
    assert.deepEqual(await adminAccess({convexUrl: CONVEX, token: 't', sub: 'u7', fetchImpl}), {areas: ['videos'], hasStore: false})
  })
})
