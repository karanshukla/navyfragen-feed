import {
  OutputSchema as RepoEvent,
  isCommit,
} from './lexicon/types/com/atproto/sync/subscribeRepos'
import { FirehoseSubscriptionBase, getOpsByType } from './util/subscription'
import { invalidateFeedCache } from './algos/navyfragen'
import { Database } from './db'

const FRAGEN_NAVY = 'fragen.navy'
const NAVYFRAGEN = 'navyfragen'
const NAVYFRAGEN_APP = 'navyfragen.app'

export class FirehoseSubscription extends FirehoseSubscriptionBase {
  private retentionMs: number

  constructor(db: Database, service: string, retentionDays: number = 30) {
    super(db, service)
    this.retentionMs = retentionDays * 24 * 60 * 60 * 1000
  }

  async handleEvent(evt: RepoEvent) {
    if (!isCommit(evt)) return

    const ops = await getOpsByType(evt)
    const now = Date.now()
    const cutoffMs = now - this.retentionMs

    const postsToDelete = ops.posts.deletes.map((del) => del.uri)
    const postsToCreate = ops.posts.creates.reduce(
      (acc, create) => {
        const createdAt = Date.parse(create.record.createdAt)
        if (createdAt < cutoffMs) {
          return acc
        }

        const text = create.record.text.toLowerCase()
        const textMatch = text.includes(FRAGEN_NAVY) || text.includes(NAVYFRAGEN_APP)

        let imageAltMatch = false
        if (
          !textMatch &&
          create.record.embed &&
          (create.record.embed.$type === 'app.bsky.embed.images#main' ||
            create.record.embed.$type === 'app.bsky.embed.images') &&
          'images' in create.record.embed &&
          Array.isArray((create.record.embed as any).images)
        ) {
          for (const image of (create.record.embed as any).images) {
            if (
              image &&
              typeof image.alt === 'string' &&
              image.alt.toLowerCase().includes(NAVYFRAGEN)
            ) {
              imageAltMatch = true
              break
            }
          }
        }

        if (textMatch || imageAltMatch) {
          acc.push({
            uri: create.uri,
            cid: create.cid,
            indexedAt: new Date(now).toISOString(),
          })
        }
        return acc
      },
      [] as { uri: string; cid: string; indexedAt: string }[],
    )

    if (postsToDelete.length > 0) {
      await this.db
        .deleteFrom('post')
        .where('uri', 'in', postsToDelete)
        .execute()
    }
    if (postsToCreate.length > 0) {
      await this.db
        .insertInto('post')
        .values(postsToCreate)
        .onConflict((oc) => oc.doNothing())
        .execute()
      invalidateFeedCache()
    }
  }
}
