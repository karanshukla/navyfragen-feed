import dotenv from 'dotenv'
import FeedGenerator from './server.js'
import { P256Keypair } from '@atproto/crypto'

const run = async () => {
  dotenv.config()
  const hostname = maybeStr(process.env.FEEDGEN_HOSTNAME) ?? 'example.com'
  let serviceDid = maybeStr(process.env.FEEDGEN_SERVICE_DID)
  if (!serviceDid) {
    // If no service DID is provided, generate a did:key
    const keypair = await P256Keypair.create({ exportable: true })
    serviceDid = keypair.did()
    console.log(`Generated did:key for service DID: ${serviceDid}`)
  }
  const server = FeedGenerator.create({
    port: maybeInt(process.env.FEEDGEN_PORT) ?? 3000,
    listenhost: maybeStr(process.env.FEEDGEN_LISTENHOST) ?? 'localhost',
    sqliteLocation: maybeStr(process.env.FEEDGEN_SQLITE_LOCATION) ?? ':memory:',
    subscriptionEndpoint:
      maybeStr(process.env.FEEDGEN_SUBSCRIPTION_ENDPOINT) ??
      'wss://jetstream1.us-east.bsky.network',
    publisherDid:
      maybeStr(process.env.FEEDGEN_PUBLISHER_DID) ?? 'did:example:alice',
    subscriptionReconnectDelay:
      maybeInt(process.env.FEEDGEN_SUBSCRIPTION_RECONNECT_DELAY) ?? 3000,
    hostname,
    serviceDid: serviceDid as string,
    handle: maybeStr(process.env.FEEDGEN_HANDLE),
    appPassword: maybeStr(process.env.FEEDGEN_APP_PASSWORD),
    // Default off. The skeleton is byte-identical for every requester (see
    // algos/navyfragen.ts, which never looks at the requester), so requiring
    // service auth buys no privacy and only decides whether a client can load
    // the feed at all. With it on, any client whose service auth we reject for
    // any reason got a 401 and showed its users an empty feed. Auth is still
    // validated when a token is presented, and the resulting DID is still used
    // for per-viewer rate limiting; it just is not mandatory. Set
    // FEEDGEN_REQUIRE_AUTH=true to make it mandatory again.
    requireAuth: process.env.FEEDGEN_REQUIRE_AUTH === 'true',
    retentionDays: maybeInt(process.env.FEEDGEN_RETENTION_DAYS) ?? 30,
    pdsUrl: maybeStr(process.env.FEEDGEN_PDS_URL) ?? 'https://bsky.social',
  })
  await server.start()
  console.log(
    `🤖 running feed generator at http://${server.cfg.listenhost}:${server.cfg.port}`,
  )
}

const maybeStr = (val?: string) => {
  if (!val) return undefined
  return val
}

const maybeInt = (val?: string) => {
  if (!val) return undefined
  const int = parseInt(val, 10)
  if (isNaN(int)) return undefined
  return int
}

run()