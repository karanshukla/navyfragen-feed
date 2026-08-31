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

// Jetstream filtered to app.bsky.feed.post still carries every post on the
// network, hundreds per second. A full minute of total silence therefore means
// the socket is dead, not that the network is quiet. A half-open TCP connection
// (an idle proxy or NAT dropping state) emits neither 'error' nor 'close', so
// without this the subscription sits there receiving nothing, forever, silently.
const STALL_TIMEOUT_MS = 60_000
const WATCHDOG_INTERVAL_MS = 15_000
const HEALTH_REPORT_INTERVAL_MS = 5 * 60_000

export class JetstreamSubscription {
  private cursor: number | undefined
  private lastSavedCursor: number | undefined
  private retentionMs: number
  private reconnectDelay = 3000
  private running = false
  private cursorInterval: ReturnType<typeof setInterval> | null = null
  private ws: WebSocket | null = null
  private lastMessageAt = 0
  private eventsSinceReport = 0
  private matchesSinceReport = 0

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

    setInterval(() => this.checkLiveness(), WATCHDOG_INTERVAL_MS)

    // Reported unconditionally, including when both counts are zero. "No events"
    // and "no log line" are different states, and telling them apart is the
    // whole point: a quiet feed and a dead subscription look identical without it.
    setInterval(() => {
      console.log(
        `jetstream: ${this.eventsSinceReport} events, ` +
          `${this.matchesSinceReport} matched in the last 5m ` +
          `(connected=${this.ws?.readyState === WebSocket.OPEN})`,
      )
      this.eventsSinceReport = 0
      this.matchesSinceReport = 0
    }, HEALTH_REPORT_INTERVAL_MS)

    this.connect()
  }

  private checkLiveness() {
    if (!this.running || this.lastMessageAt === 0) return
    const silentFor = Date.now() - this.lastMessageAt
    if (silentFor < STALL_TIMEOUT_MS) return
    console.error(
      `jetstream silent for ${Math.round(silentFor / 1000)}s, reconnecting`,
    )
    // terminate() rather than close(): a half-open socket will not complete a
    // closing handshake, and this fires the 'close' handler that reconnects.
    this.ws?.terminate()
  }

  private connect() {
    const url = new URL(`${this.service}/subscribe`)
    url.searchParams.set('wantedCollections', 'app.bsky.feed.post')
    if (this.cursor !== undefined) {
      url.searchParams.set('cursor', this.cursor.toString())
    }

    const ws = new WebSocket(url.toString())
    this.ws = ws
    // Count the connection as live while it is being established, so the
    // watchdog does not tear down a socket that has not finished connecting.
    this.lastMessageAt = Date.now()

    // 'error' is followed by 'close', so reconnecting from both would open two
    // sockets per failure and double again on each subsequent one.
    let reconnectScheduled = false
    const scheduleReconnect = () => {
      if (reconnectScheduled || !this.running) return
      reconnectScheduled = true
      setTimeout(() => this.connect(), this.reconnectDelay)
    }

    ws.on('open', () => {
      console.log(
        `jetstream connected to ${this.service}` +
          (this.cursor !== undefined ? ` at cursor ${this.cursor}` : ' at live tip'),
      )
      this.lastMessageAt = Date.now()
    })

    ws.on('message', (data: Buffer) => {
      this.lastMessageAt = Date.now()
      this.eventsSinceReport++
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
      scheduleReconnect()
    })

    ws.on('close', (code, reason) => {
      console.warn(
        `jetstream disconnected (code ${code}${
          reason?.length ? `, ${reason.toString()}` : ''
        })`,
      )
      scheduleReconnect()
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

    this.matchesSinceReport++
    const matchReason = textMatch ? 'text' : 'image-alt'
    console.log(`New post indexed [${matchReason}]: ${uri}`)

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
