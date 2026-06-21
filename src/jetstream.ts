import WebSocket from 'ws'
import { Database } from './db'
import { invalidateFeedCache } from './algos/navyfragen'

const FRAGEN_NAVY = 'fragen.navy'
const NAVYFRAGEN = 'navyfragen'
const NAVYFRAGEN_APP = 'navyfragen.app'

type JetstreamCommitEvent = {
  did: string
  time_us: number
  kind: 'commit'
  commit: {
    rev: string
    operation: 'create' | 'update' | 'delete'
    collection: string
    rkey: string
    cid?: string
    record?: {
      $type: string
      text?: string
      createdAt?: string
      embed?: {
        $type: string
        images?: { alt?: string }[]
        [key: string]: unknown
      }
    }
  }
}

type JetstreamEvent = JetstreamCommitEvent | { kind: 'identity' | 'account' }

export class JetstreamSubscription {
  private cursor: number | undefined
  private lastSavedCursor: number | undefined
  private retentionMs: number
  private reconnectDelay = 3000
  private running = false
  private cursorInterval: ReturnType<typeof setInterval> | null = null

  constructor(
    public db: Database,
    public service: string,
    retentionDays: number = 30,
  ) {
    this.retentionMs = retentionDays * 24 * 60 * 60 * 1000
  }

  async run(reconnectDelay: number) {
    this.reconnectDelay = reconnectDelay
    this.running = true
    this.cursor = await this.getCursor()

    this.cursorInterval = setInterval(() => {
      if (this.cursor !== undefined && this.cursor !== this.lastSavedCursor) {
        this.saveCursor(this.cursor)
        this.lastSavedCursor = this.cursor
      }
    }, 30_000)

    this.connect()
  }

  private connect() {
    const url = new URL(`${this.service}/subscribe`)
    url.searchParams.set('wantedCollections', 'app.bsky.feed.post')
    if (this.cursor !== undefined) {
      url.searchParams.set('cursor', this.cursor.toString())
    }

    const ws = new WebSocket(url.toString())

    ws.on('message', (data: Buffer) => {
      let evt: JetstreamEvent
      try {
        evt = JSON.parse(data.toString())
      } catch {
        return
      }
      this.handleEvent(evt).catch((err) => {
        console.error('jetstream could not handle message', err)
      })
    })

    ws.on('error', (err) => {
      console.error('jetstream error', err)
    })

    ws.on('close', () => {
      if (!this.running) return
      setTimeout(() => this.connect(), this.reconnectDelay)
    })
  }

  private async handleEvent(evt: JetstreamEvent) {
    if (evt.kind !== 'commit') return
    const { did, time_us, commit } = evt as JetstreamCommitEvent
    if (commit.collection !== 'app.bsky.feed.post') return

    this.cursor = time_us

    const uri = `at://${did}/app.bsky.feed.post/${commit.rkey}`

    if (commit.operation === 'delete') {
      await this.db.deleteFrom('post').where('uri', '=', uri).execute()
      return
    }

    if (commit.operation !== 'create' || !commit.record || !commit.cid) return

    const now = Date.now()
    const createdAt = commit.record.createdAt
      ? Date.parse(commit.record.createdAt)
      : now
    if (createdAt < now - this.retentionMs) return

    const text = (commit.record.text ?? '').toLowerCase()
    const textMatch =
      text.includes(FRAGEN_NAVY) || text.includes(NAVYFRAGEN_APP)

    let imageAltMatch = false
    if (!textMatch && commit.record.embed) {
      const embed = commit.record.embed
      if (
        (embed.$type === 'app.bsky.embed.images#main' ||
          embed.$type === 'app.bsky.embed.images') &&
        Array.isArray(embed.images)
      ) {
        for (const image of embed.images) {
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
    }

    if (!textMatch && !imageAltMatch) return

    await this.db
      .insertInto('post')
      .values({ uri, cid: commit.cid, indexedAt: new Date(now).toISOString() })
      .onConflict((oc) => oc.doNothing())
      .execute()

    invalidateFeedCache()
  }

  private async getCursor(): Promise<number | undefined> {
    const res = await this.db
      .selectFrom('sub_state')
      .selectAll()
      .where('service', '=', this.service)
      .executeTakeFirst()
    if (res) {
      this.lastSavedCursor = res.cursor
      return res.cursor
    }
    return undefined
  }

  private async saveCursor(cursor: number) {
    await this.db
      .insertInto('sub_state')
      .values({ service: this.service, cursor })
      .onConflict((oc) => oc.column('service').doUpdateSet({ cursor }))
      .execute()
  }
}
