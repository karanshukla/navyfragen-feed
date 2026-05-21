import http from 'http'
import events from 'events'
import express from 'express'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import slowDown from 'express-slow-down'
import { DidResolver, MemoryCache } from '@atproto/identity'
import { AtpAgent } from '@atproto/api'
import { createServer } from './lexicon'
import feedGeneration from './methods/feed-generation'
import describeGenerator from './methods/describe-generator'
import { createDb, Database, migrateToLatest } from './db'
import { FirehoseSubscription } from './subscription'
import { AppContext, Config } from './config'
import wellKnown from './well-known'

export class FeedGenerator {
  public app: express.Application
  public server?: http.Server
  public db: Database
  public firehose: FirehoseSubscription
  public agent?: AtpAgent
  public cfg: Config

  constructor(
    app: express.Application,
    db: Database,
    firehose: FirehoseSubscription,
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

    // Security headers
    app.use(helmet())

    // Block scanner/exploit traffic before any rate-limit tracking
    app.use((req, res, next) => {
      const bogusPatterns = [
        /\.php/i,
        /\.asp/i,
        /\.env/i,
        /\.git/i,
        /\.xml/i,
        /wp-admin/i,
        /wp-login/i,
        /wp-content/i,
        /xmlrpc/i,
        /shell/i,
        /exploit/i,
        /\/admin/i,
        /\/actuator/i,
        /\/config/i,
        /\/backup/i,
        /\/cgi-bin/i,
        /phpmyadmin/i,
        /\/setup/i,
        /\/install/i,
        /\/vendor/i,
        /\/boaform/i,
        /\/solr/i,
        /\/telescope/i,
        /\/debug/i,
      ]
      if (bogusPatterns.some((pattern) => pattern.test(req.path))) {
        return res.status(404).send()
      }
      next()
    })

    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 20, // 20 requests per 15 minutes per IP
      standardHeaders: true,
      legacyHeaders: false,
      message: 'Too many requests, please try again later.',
    })
    app.use(limiter)

    // Speed limiting (slow down repetitive requests)
    const speedLimiter = slowDown({
      windowMs: 15 * 60 * 1000,
      delayAfter: 5, // start adding delay after 5 requests
      delayMs: (hits) => hits * 500,
    })
    app.use(speedLimiter)

    // Cache-Control for feed skeleton: matches the 5-minute in-process feed cache TTL
    app.use('/xrpc/app.bsky.feed.getFeedSkeleton', (_req, res, next) => {
      res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=60')
      next()
    })

    const db = createDb(cfg.sqliteLocation)
    const firehose = new FirehoseSubscription(db, cfg.subscriptionEndpoint)

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
      agent = new AtpAgent({ service: 'https://bsky.social' })
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
      twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14)

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
      }
    } catch (err) {
      console.error('Backfill error', err)
    }
  }

  async start(): Promise<http.Server> {
    await migrateToLatest(this.db)
    await this.backfill()
    this.firehose.run(this.cfg.subscriptionReconnectDelay)
    this.server = this.app.listen(this.cfg.port, this.cfg.listenhost)
    await events.once(this.server, 'listening')
    return this.server
  }
}

export default FeedGenerator
