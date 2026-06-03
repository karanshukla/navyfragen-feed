import { Subscription } from '@atproto/xrpc-server'
import { cborToLexRecord, readCar } from '@atproto/repo'
import { ids, lexicons } from '../lexicon/lexicons'
import { Record as PostRecord } from '../lexicon/types/app/bsky/feed/post'
import {
  Commit,
  OutputSchema as RepoEvent,
  isCommit,
} from '../lexicon/types/com/atproto/sync/subscribeRepos'
import { Database } from '../db'

export abstract class FirehoseSubscriptionBase {
  public sub: Subscription<RepoEvent>
  private cursor: number | undefined
  private lastSavedCursor: number | undefined

  constructor(public db: Database, public service: string) {
    this.sub = new Subscription({
      service: service,
      method: ids.ComAtprotoSyncSubscribeRepos,
      getParams: () => this.getCursor(),
      validate: (value: unknown) => {
        try {
          return lexicons.assertValidXrpcMessage<RepoEvent>(
            ids.ComAtprotoSyncSubscribeRepos,
            value,
          )
        } catch (err) {
          console.error('repo subscription skipped invalid message', err)
        }
      },
    })
  }

  abstract handleEvent(evt: RepoEvent): Promise<void>

  async run(subscriptionReconnectDelay: number) {
    const interval = setInterval(() => {
      if (this.cursor && this.cursor !== this.lastSavedCursor) {
        this.updateCursor(this.cursor)
        this.lastSavedCursor = this.cursor
      }
    }, 30_000)

    try {
      for await (const evt of this.sub) {
        this.handleEvent(evt).catch((err) => {
          console.error('repo subscription could not handle message', err)
        })
        if (isCommit(evt)) {
          this.cursor = evt.seq
        }
      }
    } catch (err) {
      console.error('repo subscription errored', err)
      clearInterval(interval)
      setTimeout(
        () => this.run(subscriptionReconnectDelay),
        subscriptionReconnectDelay,
      )
    }
  }

  async updateCursor(cursor: number) {
    await this.db
      .updateTable('sub_state')
      .set({ cursor })
      .where('service', '=', this.service)
      .execute()
  }

  async getCursor(): Promise<{ cursor?: number }> {
    const res = await this.db
      .selectFrom('sub_state')
      .selectAll()
      .where('service', '=', this.service)
      .executeTakeFirst()
    if (res) {
      this.lastSavedCursor = res.cursor
      return { cursor: res.cursor }
    }
    return {}
  }
}

export const getOpsByType = async (evt: Commit): Promise<OperationsByType> => {
  const opsByType: OperationsByType = {
    posts: { creates: [], deletes: [] },
  }

  // Pre-filter to only feed-post ops before doing expensive CAR parsing.
  // Most commits are likes, follows, reposts, etc. — skip them entirely.
  const postOps = evt.ops.filter(
    (op) => op.path.split('/')[0] === ids.AppBskyFeedPost,
  )
  if (postOps.length === 0) return opsByType

  const car = await readCar(evt.blocks)

  for (const op of postOps) {
    const uri = `at://${evt.repo}/${op.path}`

    if (op.action === 'create') {
      if (!op.cid) continue
      const recordBytes = car.blocks.get(op.cid)
      if (!recordBytes) continue
      const record = cborToLexRecord(recordBytes)
      if (isPost(record)) {
        opsByType.posts.creates.push({
          uri,
          cid: op.cid.toString(),
          author: evt.repo,
          record,
        })
      }
    } else if (op.action === 'delete') {
      opsByType.posts.deletes.push({ uri })
    }
  }

  return opsByType
}

type OperationsByType = {
  posts: Operations<PostRecord>
}

type Operations<T = Record<string, unknown>> = {
  creates: CreateOp<T>[]
  deletes: DeleteOp[]
}

type CreateOp<T> = {
  uri: string
  cid: string
  author: string
  record: T
}

type DeleteOp = {
  uri: string
}

// Fast duck-type check — avoids full schema validation + recursive fixBlobRefs
// on every post in the firehose hot path.
export const isPost = (obj: unknown): obj is PostRecord => {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    '$type' in obj &&
    (obj as Record<string, unknown>)['$type'] === ids.AppBskyFeedPost &&
    'text' in obj &&
    typeof (obj as Record<string, unknown>)['text'] === 'string'
  )
}
