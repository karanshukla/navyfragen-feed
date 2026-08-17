import { Server } from '@atproto/xrpc-server'
import { AtUri } from '@atproto/syntax'
import { ids } from '@atproto/api'
import { AppContext } from '../config'
import algos from '../algos'

export default function (server: Server, ctx: AppContext) {
  server.method(ids.AppBskyFeedDescribeFeedGenerator, async () => {
    const feeds = Object.keys(algos).map((shortname) => ({
      uri: AtUri.make(
        ctx.cfg.publisherDid,
        ids.AppBskyFeedGenerator,
        shortname,
      ).toString(),
    }))
    return {
      encoding: 'application/json',
      body: {
        did: ctx.cfg.serviceDid,
        feeds,
      },
    }
  })
}
