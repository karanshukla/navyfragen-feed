# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
yarn install        # install dependencies
yarn build          # compile TypeScript to dist/
yarn start          # run with ts-node (no compile step needed)
yarn publishFeed    # publish/update the feed record on Bluesky
yarn unpublishFeed  # delete the feed record from Bluesky
```

There are no tests. Build (`yarn build`) is the primary correctness check — always run it after changes.

## Architecture

This is a Bluesky ATProto **feed generator** for Navy Fragen content. It surfaces posts containing `fragen.navy` in text or `navyfragen` in image alt text.

### Two independent data pipelines

**1. Firehose ingestion (write path)**
`FirehoseSubscription` (extends `FirehoseSubscriptionBase`) opens a persistent WebSocket to `wss://bsky.network` via `@atproto/xrpc-server`'s `Subscription` class. Every commit event is passed to `handleEvent()` in `src/subscription.ts`, which filters for matching posts and writes them to the `post` SQLite table. The firehose cursor is persisted to `sub_state` every 30 seconds so reconnects resume from the right position.

Key optimization: `getOpsByType()` in `src/util/subscription.ts` pre-filters `evt.ops` to only `app.bsky.feed.post` entries before doing the expensive `readCar(evt.blocks)` call. Most firehose events (likes, follows, reposts) are discarded with zero CAR/CBOR parsing.

**2. Feed serving (read path)**
Express app exposes `/xrpc/app.bsky.feed.getFeedSkeleton` via the XRPC server from `@atproto/xrpc-server`. The handler in `src/methods/feed-generation.ts` queries the `post` table ordered by `indexedAt DESC`. Results are cached in-process (`src/algos/navyfragen.ts`) with a 5-minute TTL, invalidated early (throttled to once/min) when a matching post arrives via firehose.

**Startup backfill** (`FeedGenerator.backfill()` in `src/server.ts`): runs once before the server starts listening. Calls `app.bsky.feed.searchPosts` on `bsky.social` for both query terms to recover posts from the past 2 weeks. Requires `FEEDGEN_HANDLE` + `FEEDGEN_APP_PASSWORD` env vars; silently skips if absent.

### Adding a new feed algorithm

1. Create `src/algos/<shortname>.ts` exporting `shortname` (≤15 chars) and `handler: (ctx, params) => Promise<{feed, cursor}>`
2. Register it in `src/algos/index.ts`
3. Publish with `yarn publishFeed` (update the shortname in the script)

### Database

Two tables, managed by Kysely migrations in `src/db/migrations.ts`:
- `post (uri PK, cid, indexedAt)` — indexed on `indexedAt`
- `sub_state (service PK, cursor)` — one row per firehose endpoint

**Production requirement:** Set `FEEDGEN_SQLITE_LOCATION` to a path on a persistent volume (e.g. `/data/feed.db`). The default (`:memory:`) and any file path on Railway's ephemeral filesystem are wiped on each deployment.

### Rate limiting layers

1. `express-rate-limit` — 20 req / 15 min per IP (outermost)
2. `express-slow-down` — delay added after 5 req / 15 min per IP
3. Per-DID/IP limiter in `feed-generation.ts` — 4 req/min authenticated, 2 req/min unauthenticated

### Auth

`src/auth.ts` validates the ATProto service-auth JWT on each `getFeedSkeleton` request. DID key resolution calls `plc.directory` and is cached by `MemoryCache` (1h stale TTL, 24h max TTL). Unauthenticated requests are allowed through with `requesterDid = undefined`.
