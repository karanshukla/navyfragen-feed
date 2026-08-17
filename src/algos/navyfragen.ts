import { AppBskyFeedGetFeedSkeleton } from '@atproto/api'
import { AppContext } from '../config'

type QueryParams = AppBskyFeedGetFeedSkeleton.QueryParams

// max 15 chars
export const shortname = 'navyfragen'

type FeedResult = { cursor: string | undefined; feed: { post: string }[] }
type CacheEntry = { result: FeedResult; expires: number }

const feedCache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 2 * 60_000 // 2 minutes; invalidated early when new posts arrive
const MAX_CACHE_ENTRIES = 100

// Throttle invalidations to at most once per 60s so the cache stays warm
// during rapid bursts of matching posts.
let lastInvalidatedAt = 0
const MIN_INVALIDATION_INTERVAL_MS = 60_000

export const invalidateFeedCache = () => {
  const now = Date.now()
  if (now - lastInvalidatedAt >= MIN_INVALIDATION_INTERVAL_MS) {
    feedCache.clear()
    lastInvalidatedAt = now
  }
}

// Matches the `limit` default declared in the app.bsky.feed.getFeedSkeleton
// lexicon. The XRPC params verifier normally fills this in, but the generated
// type marks it optional, so fall back explicitly.
const DEFAULT_LIMIT = 50

const getCacheKey = (limit: number, cursor?: string) =>
  `${limit}:${cursor ?? ''}`

export const handler = async (ctx: AppContext, params: QueryParams) => {
  const limit = params.limit ?? DEFAULT_LIMIT
  const cacheKey = getCacheKey(limit, params.cursor)
  const now = Date.now()
  const cached = feedCache.get(cacheKey)
  if (cached && cached.expires > now) {
    return cached.result
  }

  let builder = ctx.db
    .selectFrom('post')
    .selectAll()
    .orderBy('indexedAt', 'desc')
    .orderBy('cid', 'desc')
    .limit(limit)

  if (params.cursor) {
    const timeStr = new Date(parseInt(params.cursor, 10)).toISOString()
    builder = builder.where('post.indexedAt', '<', timeStr)
  }
  const res = await builder.execute()

  const feed = res.map((row) => ({
    post: row.uri,
  }))

  let cursor: string | undefined
  const last = res.at(-1)
  if (last) {
    cursor = new Date(last.indexedAt).getTime().toString(10)
  }

  const result: FeedResult = { cursor, feed }
  feedCache.set(cacheKey, { result, expires: now + CACHE_TTL_MS })

  if (feedCache.size > MAX_CACHE_ENTRIES) {
    const firstKey = feedCache.keys().next().value
    if (firstKey !== undefined) feedCache.delete(firstKey)
  }

  return result
}
