import {
  InvalidRequestError,
  AuthRequiredError,
  Server,
} from '@atproto/xrpc-server'
import { AppBskyFeedGetFeedSkeleton, ids } from '@atproto/api'
import { AtUri } from '@atproto/syntax'
import { AppContext } from '../config'
import algos from '../algos'
import { validateAuth, unverifiedIssuer } from '../auth'

const authenticatedRateLimiter = new Map<
  string,
  { count: number; lastReset: number }
>()
const unauthenticatedRateLimiter = new Map<
  string,
  { count: number; lastReset: number }
>()

const RATE_LIMIT_WINDOW_MS = 60 * 1000
// The Bluesky client refetches the skeleton on every feed open, pull-to-refresh,
// tab switch and prefetch, per device. 15/min was low enough that an account
// used on phone plus web could trip it while a lightly-used account never did,
// and a tripped account just keeps showing whatever it already had, which looks
// like "the feed stopped updating" rather than an error. This is a shield
// against abuse, not a quota, so it sits well above normal client behaviour.
const MAX_REQUESTS_PER_WINDOW_AUTH = 100
// Keyed by IP, and getFeedSkeleton is called by an AppView server-side, so this
// bucket is shared by every viewer behind that AppView rather than being one
// person's budget. 5/min was a global cap on anonymous traffic, which mattered
// little while auth was mandatory (the branch was unreachable) and would have
// become the new bottleneck the moment it was not. The outer per-IP limiter in
// server.ts is the real backstop; this one only needs to stop a single source
// from monopolising the process.
const MAX_REQUESTS_PER_WINDOW_UNAUTH = 100
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

const cleanupRateLimiters = () => {
  const now = Date.now()
  authenticatedRateLimiter.forEach((value, key) => {
    if (now - value.lastReset > RATE_LIMIT_WINDOW_MS) {
      authenticatedRateLimiter.delete(key)
    }
  })
  unauthenticatedRateLimiter.forEach((value, key) => {
    if (now - value.lastReset > RATE_LIMIT_WINDOW_MS) {
      unauthenticatedRateLimiter.delete(key)
    }
  })
}

setInterval(cleanupRateLimiters, CLEANUP_INTERVAL_MS)

export default function (server: Server, ctx: AppContext) {
  server.method(ids.AppBskyFeedGetFeedSkeleton, async ({ params, req }) => {
    const { feed, limit, cursor } =
      params as AppBskyFeedGetFeedSkeleton.QueryParams
    const feedUri = new AtUri(feed)
    const algo = algos[feedUri.rkey]
    if (
      feedUri.hostname !== ctx.cfg.publisherDid ||
      feedUri.collection !== ids.AppBskyFeedGenerator ||
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
      // Everything thrown here comes out of validateAuth, so it is an auth
      // failure however it is typed. Previously only AuthRequiredError was
      // handled and anything else became a 500: a token verifyJwt rejects
      // before it can raise AuthRequiredError (e.g. `Bearer not.a.jwt`) gave
      // the caller an Internal Server Error instead of a 401.
      //
      // Log the claimed issuer so a single account failing to authenticate
      // (rotated signing key, unreachable did:web, PDS the resolver can't
      // reach) is distinguishable in the logs from a stale feed. Only when a
      // token was actually presented; a request with no Authorization header
      // is an anonymous hit, not a failure worth logging.
      const issuer = unverifiedIssuer(req)
      if (issuer) {
        console.warn(
          `Auth failed for ${issuer}: ${(e as Error).message || 'AuthRequired'}`,
        )
      }
      if (ctx.cfg.requireAuth) {
        throw new AuthRequiredError(
          'Valid ATProto service auth is required to access this feed.',
        )
      }
      requesterDid = undefined
    }

    const now = Date.now()

    if (requesterDid) {
      const userRate = authenticatedRateLimiter.get(requesterDid)
      if (userRate && now - userRate.lastReset < RATE_LIMIT_WINDOW_MS) {
        if (userRate.count >= MAX_REQUESTS_PER_WINDOW_AUTH) {
          console.warn(
            `Rate limit exceeded for ${requesterDid} ` +
              `(${userRate.count} requests in the last ${RATE_LIMIT_WINDOW_MS}ms)`,
          )
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
          console.warn(
            `Rate limit exceeded for unauthenticated IP ${ip} ` +
              `(${ipRate.count} requests in the last ${RATE_LIMIT_WINDOW_MS}ms)`,
          )
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

    const body = await algo(ctx, { feed, limit, cursor })
    return {
      encoding: 'application/json',
      body,
    }
  })
}
