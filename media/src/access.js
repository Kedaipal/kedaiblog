/*
 * Who may use this page — ONE list, kept in Convex.
 *
 * The Worker calls the main app's public query `adminAccess:mine` over Convex's
 * HTTP API, passing the caller's own `convex`-template token. Convex verifies
 * the token again, works out the areas from its env (`BLOG_EDITOR_USER_IDS`,
 * `ADMIN_USER_IDS`) and returns `{areas: string[]}`. The page needs "videos".
 *
 * Nothing about who is allowed lives in this repo; adding or removing a writer
 * is a Convex env change. The answer is cached per user for a minute so an
 * upload's status polling does not hit Convex every few seconds.
 *
 * The query itself is built in the main app (separate PR, base `staging`).
 */

export const ACCESS_QUERY = 'adminAccess:mine'
const TTL_MS = 60 * 1000
const cache = new Map() // sub -> {areas, until}

export class AccessUnavailable extends Error {}

/**
 * @param {object} o
 * @param {string} o.convexUrl   https://<deployment>.convex.cloud
 * @param {string} o.token       the caller's verified `convex` token
 * @param {string} o.sub         the caller's Clerk user id (cache key)
 * @param {Function} [o.fetchImpl]
 * @returns {Promise<string[]>}  the caller's admin areas
 * @throws {AccessUnavailable}   Convex unreachable, or the query is missing / failed
 */
export async function adminAreas({convexUrl, token, sub, fetchImpl = fetch, now = Date.now()}) {
  const hit = cache.get(sub)
  if (hit && hit.until > now) return hit.areas

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
  const areas = Array.isArray(body.value?.areas) ? body.value.areas.filter((a) => typeof a === 'string') : []
  cache.set(sub, {areas, until: now + TTL_MS})
  return areas
}

/** Tests only. */
export function clearAccessCache() {
  cache.clear()
}
