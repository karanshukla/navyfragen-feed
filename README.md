# navyfragen-feed

A [Bluesky](https://bsky.app) custom feed generator for [NavyFragen](https://navyfragen.app) content. Surfaces posts that contain `fragen.navy` in their text, or images with `navyfragen` in the alt text.

Built on the [AT Protocol](https://atproto.com) using the official feed generator starter kit.

## How it works

1. **Firehose subscription** — connects to `wss://bsky.network` and processes the full Bluesky event stream in real-time. Only post operations are decoded; non-post commits are skipped before any expensive CAR/CBOR parsing.
2. **Matching logic** — each post is checked for `fragen.navy` in text, or `navyfragen` in image alt text. Matches are stored in a local SQLite database.
3. **Startup backfill** — on each startup, recent posts are recovered via Bluesky's search API (past 2 weeks) to fill any gap caused by downtime or redeployment.
4. **Feed serving** — the `app.bsky.feed.getFeedSkeleton` XRPC endpoint returns a cursor-paginated list of matching post URIs, with an in-process 5-minute cache.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `FEEDGEN_PORT` | No | `3000` | HTTP port to listen on |
| `FEEDGEN_LISTENHOST` | No | `localhost` | Host to bind (`0.0.0.0` for Railway/Docker) |
| `FEEDGEN_HOSTNAME` | Yes | — | Public hostname (e.g. `navyfragen-feed.railway.app`) |
| `FEEDGEN_SERVICE_DID` | No | auto-generated `did:key` | DID for this service |
| `FEEDGEN_PUBLISHER_DID` | Yes | — | DID of the Bluesky account that owns the feed |
| `FEEDGEN_SQLITE_LOCATION` | No | `:memory:` | Path to SQLite database file. **Use a persistent volume path in production** (e.g. `/data/feed.db`) |
| `FEEDGEN_SUBSCRIPTION_ENDPOINT` | No | `wss://bsky.network` | ATProto firehose endpoint |
| `FEEDGEN_SUBSCRIPTION_RECONNECT_DELAY` | No | `3000` | Milliseconds to wait before reconnecting the firehose |
| `FEEDGEN_HANDLE` | No | — | Bluesky handle for backfill (e.g. `you.bsky.social`) |
| `FEEDGEN_APP_PASSWORD` | No | — | App password for backfill. If unset, backfill is skipped |

> **Important (Railway):** Set `FEEDGEN_SQLITE_LOCATION` to a path on a mounted persistent volume (e.g. `/data/feed.db`). Without this, the database is wiped on every deployment.

## Running locally

```bash
yarn install
cp .env.example .env   # fill in at minimum FEEDGEN_HOSTNAME and FEEDGEN_PUBLISHER_DID
yarn start
```

The feed skeleton is available at:
```
http://localhost:3000/xrpc/app.bsky.feed.getFeedSkeleton?feed=at://<FEEDGEN_PUBLISHER_DID>/app.bsky.feed.generator/navyfragen
```

## Publishing the feed to Bluesky

Fill in the variables at the top of `scripts/publishFeedGen.ts`, then:

```bash
yarn publishFeed
```

Re-run the script any time you want to update the feed's display name, avatar, or description.

To remove the feed from Bluesky:

```bash
yarn unpublishFeed
```

## Deploying on Railway

1. Connect this repository to a Railway service.
2. Add a **persistent volume** mounted at `/data`.
3. Set all required environment variables, plus `FEEDGEN_SQLITE_LOCATION=/data/feed.db` and `FEEDGEN_LISTENHOST=0.0.0.0`.
4. Deploy.

## Project structure

```
src/
  index.ts            — entry point, loads config and starts the server
  server.ts           — Express app setup, FeedGenerator class, backfill logic
  subscription.ts     — firehose event handler (matching logic)
  auth.ts             — JWT validation for incoming requests
  config.ts           — AppContext and Config types
  well-known.ts       — /.well-known/did.json endpoint
  algos/
    navyfragen.ts     — feed algorithm with in-process cache
  methods/
    feed-generation.ts   — getFeedSkeleton XRPC handler + per-user rate limiting
    describe-generator.ts — describeFeedGenerator XRPC handler
  db/
    index.ts          — SQLite connection with WAL mode
    migrations.ts     — database schema migrations
  util/
    subscription.ts   — base firehose subscription class + cursor persistence
scripts/
  publishFeedGen.ts   — publish/update the feed record on Bluesky
  unpublishFeedGen.ts — delete the feed record from Bluesky
```
