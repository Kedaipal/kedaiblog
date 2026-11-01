/*
 * Who may use this page — ONE list, kept in Convex.
 *
 * The Worker calls the main app's public query `adminAccess:mine` over Convex's
 * HTTP API, passing the caller's own `convex`-template token. Convex verifies
 * the token again, works out the areas from its env (`BLOG_EDITOR_USER_IDS`,
 * `ADMIN_USER_IDS`) and returns `{areas: string[], hasStore: boolean}`. The page
 * needs "videos". `hasStore` is the app's own "does this person have a store"
 * rule (Kedaipal/kedaipal#423): without one the app sends them to onboarding,
 * so the page must not offer them a way "back to the app". An older Convex
 * without the field counts as no store.
 *
 * Nothing about who is allowed lives in this repo; adding or removing a writer
 * is a Convex env change. The answer is cached per user for a minute so an
 * upload's status polling does not hit Convex every few seconds.
 *
 * The query itself is built in the main app (separate PR, base `staging`).
 */

export const ACCESS_QUERY = 'adminAccess:mine'
const TTL_MS = 60 * 1000
const cache = new Map() // sub -> {access: {areas, hasStore}, until}

export class AccessUnavailable extends Error {}

/**
 * @param {object} o
 * @param {string} o.convexUrl   https://<deployment>.convex.cloud
 * @param {string} o.token       the caller's verified `convex` token
 * @param {string} o.sub         the caller's Clerk user id (cache key)
 * @param {Function} [o.fetchImpl]
 * @returns {Promise<{areas: string[], hasStore: boolean}>}
 * @throws {AccessUnavailable}   Convex unreachable, or the query is missing / failed
 */
export async function adminAccess({convexUrl, token, sub, fetchImpl = fetch, now = Date.now()}) {
  const hit = cache.get(sub)
  if (hit && hit.until > now) return hit.access

  let res
  try {
    res = await fetchImpl(`${convexUrl.replace(/\/+$/, '')}/api/query`, {
      method: 'POST',
      headers: {'content-type': 'application/json', authorization: `Bearer ${token}`},
      body: JSON.stringify({path: ACCESS_QUERY, args: {}, format: 'json'}),
    })
  } catch (err) {
    throw new AccessUnavailable(`Convex unreachable: ${err.message}`)
  }
  const body = await res.json().catch(() => null)
  if (!res.ok || body?.status !== 'success') {
    throw new AccessUnavailable(`Access check failed (${res.status}): ${body?.errorMessage || 'no detail'}`)
  }
  const access = {
    areas: Array.isArray(body.value?.areas) ? body.value.areas.filter((a) => typeof a === 'string') : [],
    hasStore: body.value?.hasStore === true,
  }
  cache.set(sub, {access, until: now + TTL_MS})
  return access
}

/** Tests only. */
export function clearAccessCache() {
  cache.clear()
}
