import { Database } from './db'
import { DidResolver, MemoryCache } from '@atproto/identity'

export type AppContext = {
  db: Database
  didResolver: DidResolver
  cfg: Config
  didCache: MemoryCache
}

export type Config = {
  port: number
  listenhost: string
  hostname: string
  sqliteLocation: string
  subscriptionEndpoint: string
  serviceDid: string
  publisherDid: string
  subscriptionReconnectDelay: number
  handle?: string
  appPassword?: string
}
