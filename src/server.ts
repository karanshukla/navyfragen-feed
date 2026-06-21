import http from 'http'
import events from 'events'
import express from 'express'
import { sql } from 'kysely'
import compression from 'compression'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import slowDown from 'express-slow-down'
import { DidResolver, MemoryCache } from '@atproto/identity'
import { AtpAgent } from '@atproto/api'
import { createServer } from './lexicon'
import feedGeneration from './methods/feed-generation'
import describeGenerator from './methods/describe-generator'
import { createDb, Database, migrateToLatest } from './db'
import { JetstreamSubscription } from './jetstream'
import { AppContext, Config } from './config'
import wellKnown from './well-known'

export class FeedGenerator {
  public app: express.Application
  public server?: http.Server
  public db: Database
  public firehose: JetstreamSubscription
  public agent?: AtpAgent
  public cfg: Config

  constructor(
    app: express.Application,
    db: Database,
    firehose: JetstreamSubscription,
    cfg: Config,
    agent?: AtpAgent,
  ) {
    this.app = app
    this.db = db
    this.firehose = firehose
    this.cfg = cfg
    this.agent = agent
  }

  static create(cfg: Config) {
    const app = express()
    app.set('trust proxy', 1)

    // Allowlist first — unknown paths get a silent 404 before touching any
    // other middleware (compression, rate limiting, etc.)
    const ALLOWED_PATHS = new Set([
      '/.well-known/did.json',
      '/xrpc/app.bsky.feed.getFeedSkeleton',
      '/xrpc/app.bsky.feed.describeFeedGenerator',
    ])
    app.use((req, res, next) => {
      if (ALLOWED_PATHS.has(req.path)) return next()
      return res.status(404).send()
    })

    // Compress all responses
    app.use(compression() as unknown as express.RequestHandler)

    // Security headers
    app.use(helmet())

    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 200, // 200 requests per 15 minutes per IP
      standardHeaders: true,
      legacyHeaders: false,
      message: 'Too many requests, please try again later.',
    })
    app.use(limiter)

    // Speed limiting (slow down repetitive requests)
    const speedLimiter = slowDown({
      windowMs: 15 * 60 * 1000,
      delayAfter: 50, // start adding delay after 50 requests
      delayMs: (hits) => hits * 200,
    })
    app.use(speedLimiter)

    // Feed skeleton: 10-minute cache with 2-minute stale grace period
    app.use('/xrpc/app.bsky.feed.getFeedSkeleton', (_req, res, next) => {
      res.set('Cache-Control', 'public, max-age=600, stale-while-revalidate=120')
      next()
    })

    // describeFeedGenerator is static metadata that almost never changes
    app.use('/xrpc/app.bsky.feed.describeFeedGenerator', (_req, res, next) => {
      res.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=600')
      next()
    })

    const db = createDb(cfg.sqliteLocation)
    const firehose = new JetstreamSubscription(db, cfg.subscriptionEndpoint, cfg.retentionDays)

    const didCache = new MemoryCache()
    const didResolver = new DidResolver({
      plcUrl: 'https://plc.directory',
      didCache,
    })

    const server = createServer({
      validateResponse: false, // Reduced CPU/Memory by disabling response validation
      payload: {
        jsonLimit: 50 * 1024, // Reduced to 50kb
        textLimit: 50 * 1024, // Reduced to 50kb
        blobLimit: 1 * 1024 * 1024, // Reduced to 1mb
      },
    })
    const ctx: AppContext = {
      db,
      didResolver,
      cfg,
      didCache,
    }
    feedGeneration(server, ctx)
    describeGenerator(server, ctx)
    app.use(server.xrpc.router)
    app.use(wellKnown(ctx))

    let agent: AtpAgent | undefined = undefined
    if (cfg.handle && cfg.appPassword) {
      agent = new AtpAgent({ service: cfg.pdsUrl })
    }

    return new FeedGenerator(app, db, firehose, cfg, agent)
  }

  async backfill() {
    if (!this.agent) {
      console.log('No agent for backfill, skipping')
      return
    }
    console.log('Backfilling posts...')
    try {
      await this.agent.login({
        identifier: this.cfg.handle!,
        password: this.cfg.appPassword!,
      })
      const twoWeeksAgo = new Date()
      twoWeeksAgo.setDate(twoWeeksAgo.getDate() - this.cfg.retentionDays)

      const uniqueUris = new Set<string>()
      const postsToCreate: { uri: string; cid: string; indexedAt: string }[] =
        []

      const textResults = await this.agent.api.app.bsky.feed.searchPosts({
        q: 'fragen.navy',
        limit: 100,
      })
      for (const post of textResults.data.posts) {
        if (
          new Date(post.indexedAt) > twoWeeksAgo &&
          !uniqueUris.has(post.uri)
        ) {
          uniqueUris.add(post.uri)
          postsToCreate.push({
            uri: post.uri,
            cid: post.cid,
            indexedAt: new Date(post.indexedAt).toISOString(),
          })
        }
      }

      if (postsToCreate.length > 0) {
        console.log(`Backfilling ${postsToCreate.length} posts`)
        await this.db
          .insertInto('post')
          .values(postsToCreate)
          .onConflict((oc) => oc.doNothing())
          .execute()
        postsToCreate.length = 0 // Clear the array
      }

      const altTextResults = await this.agent.api.app.bsky.feed.searchPosts({
        q: 'navyfragen',
        limit: 100,
      })
      for (const post of altTextResults.data.posts) {
        if (new Date(post.indexedAt) < twoWeeksAgo || uniqueUris.has(post.uri))
          continue

        let imageAltMatch = false
        if (
          post.embed &&
          post.embed.$type === 'app.bsky.embed.images#view' &&
          'images' in post.embed &&
          Array.isArray((post.embed as any).images)
        ) {
          for (const image of (post.embed as any).images) {
            if (
              image &&
              typeof image.alt === 'string' &&
              image.alt.toLowerCase().includes('navyfragen')
            ) {
              imageAltMatch = true
              break
            }
          }
        }

        if (imageAltMatch) {
          uniqueUris.add(post.uri)
          postsToCreate.push({
            uri: post.uri,
            cid: post.cid,
            indexedAt: new Date(post.indexedAt).toISOString(),
          })
        }
      }

      if (postsToCreate.length > 0) {
        console.log(`Backfilling ${postsToCreate.length} posts`)
        await this.db
          .insertInto('post')
          .values(postsToCreate)
          .onConflict((oc) => oc.doNothing())
          .execute()
        postsToCreate.length = 0
      }

      const appResults = await this.agent.api.app.bsky.feed.searchPosts({
        q: 'navyfragen.app',
        limit: 100,
      })
      for (const post of appResults.data.posts) {
        if (new Date(post.indexedAt) < twoWeeksAgo || uniqueUris.has(post.uri))
          continue
        uniqueUris.add(post.uri)
        postsToCreate.push({
          uri: post.uri,
          cid: post.cid,
          indexedAt: new Date(post.indexedAt).toISOString(),
        })
      }

      if (postsToCreate.length > 0) {
        console.log(`Backfilling ${postsToCreate.length} posts`)
        await this.db
          .insertInto('post')
          .values(postsToCreate)
          .onConflict((oc) => oc.doNothing())
          .execute()
      }
    } catch (err: any) {
      if (err?.status === 401 || err?.error === 'AuthenticationRequired') {
        console.warn(
          'Backfill skipped: invalid FEEDGEN_HANDLE or FEEDGEN_APP_PASSWORD. ' +
          'Generate a new app password at bsky.app → Settings → App Passwords.',
        )
      } else {
        console.error('Backfill error:', err?.message ?? err)
      }
    }
  }

  async pruneOldPosts() {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - this.cfg.retentionDays)
    const cutoffStr = cutoff.toISOString()

    const result = await this.db
      .deleteFrom('post')
      .where('indexedAt', '<', cutoffStr)
      .executeTakeFirst()

    console.log(`Pruned ${result.numDeletedRows} posts older than ${cutoffStr}`)

    if (this.cfg.sqliteLocation !== ':memory:') {
      await sql`VACUUM`.execute(this.db)
      console.log('Ran VACUUM to reclaim database space')
    }
  }

  async start(): Promise<http.Server> {
    await migrateToLatest(this.db)
    await this.backfill()
    await this.pruneOldPosts()

    const now = new Date()
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    setTimeout(() => {
      this.pruneOldPosts()
      setInterval(() => this.pruneOldPosts(), 24 * 60 * 60 * 1000)
    }, midnight.getTime() - now.getTime())

    setInterval(() => {
      const m = process.memoryUsage()
      const mb = (n: number) => (n / 1024 / 1024).toFixed(1)
      console.log(`Memory: heap ${mb(m.heapUsed)}/${mb(m.heapTotal)} MB, RSS ${mb(m.rss)} MB`)
    }, 5 * 60 * 1000)

    this.firehose.run(this.cfg.subscriptionReconnectDelay)
    this.server = this.app.listen(this.cfg.port, this.cfg.listenhost)
    await events.once(this.server, 'listening')
    return this.server
  }
}

export default FeedGenerator
