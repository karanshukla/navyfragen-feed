import { QueryParams } from '../lexicon/types/app/bsky/feed/getFeedSkeleton'
import { AppContext } from '../config'

// max 15 chars
export const shortname = 'navyfragen'

type FeedResult = { cursor: string | undefined; feed: { post: string }[] }
type CacheEntry = { result: FeedResult; expires: number }

const feedCache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 5 * 60_000 // 5 minutes; invalidated early when new posts arrive

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

const getCacheKey = (params: QueryParams) =>
  `${params.limit}:${params.cursor ?? ''}`

export const handler = async (ctx: AppContext, params: QueryParams) => {
  const cacheKey = getCacheKey(params)
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
    .limit(params.limit)

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

  return result
}
