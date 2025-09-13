import { InvalidRequestError, AuthRequiredError } from '@atproto/xrpc-server'
import { Server } from '../lexicon'
import { AppContext } from '../config'
import algos from '../algos'
import { validateAuth } from '../auth'
import { AtUri } from '@atproto/syntax'

const authenticatedRateLimiter = new Map<
  string,
  { count: number; lastReset: number }
>()
const unauthenticatedRateLimiter = new Map<
  string,
  { count: number; lastReset: number }
>()

const RATE_LIMIT_WINDOW_MS = 60 * 1000
const MAX_REQUESTS_PER_WINDOW_AUTH = 10
const MAX_REQUESTS_PER_WINDOW_UNAUTH = 5

export default function (server: Server, ctx: AppContext) {
  server.app.bsky.feed.getFeedSkeleton(async ({ params, req }) => {
    const feedUri = new AtUri(params.feed)
    const algo = algos[feedUri.rkey]
    if (
      feedUri.hostname !== ctx.cfg.publisherDid ||
      feedUri.collection !== 'app.bsky.feed.generator' ||
      !algo
    ) {
      throw new InvalidRequestError(
        'Unsupported algorithm',
        'UnsupportedAlgorithm',
      )
    }

    let requesterDid: string | undefined
    try {
      requesterDid = await validateAuth(
        req,
        ctx.cfg.serviceDid,
        ctx.didResolver,
      )
    } catch (e) {
      if (e instanceof AuthRequiredError) {
        requesterDid = undefined
      } else {
        throw e
      }
    }

    const now = Date.now()

    if (requesterDid) {
      const userRate = authenticatedRateLimiter.get(requesterDid)
      if (userRate && now - userRate.lastReset < RATE_LIMIT_WINDOW_MS) {
        if (userRate.count >= MAX_REQUESTS_PER_WINDOW_AUTH) {
          throw new InvalidRequestError(
            'Rate limit exceeded for authenticated user. Please try again later.',
            'RateLimitExceeded',
          )
        }
        userRate.count++
      } else {
        authenticatedRateLimiter.set(requesterDid, { count: 1, lastReset: now })
      }
    } else {
      const ip = req.ip || 'unknown_ip'
      const ipRate = unauthenticatedRateLimiter.get(ip)

      if (ipRate && now - ipRate.lastReset < RATE_LIMIT_WINDOW_MS) {
        if (ipRate.count >= MAX_REQUESTS_PER_WINDOW_UNAUTH) {
          throw new InvalidRequestError(
            'Rate limit exceeded for unauthenticated requests from this IP. Please try again later.',
            'RateLimitExceeded',
          )
        }
        ipRate.count++
      } else {
        unauthenticatedRateLimiter.set(ip, { count: 1, lastReset: now })
      }
    }

    const body = await algo(ctx, params)
    return {
      encoding: 'application/json',
      body: body,
    }
  })
}
