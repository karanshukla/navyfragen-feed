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

There are no tests. Build (`yarn build`) is the primary correctness check — always run it after changes. The `dev-integration` workflow additionally boots the server and curls `describeFeedGenerator`, `getFeedSkeleton`, and `/.well-known/did.json`.

**Node 24 (LTS) is required.** The `@atproto/*` packages are ESM-only and declare `engines: node >= 22`; the build emits CommonJS that `require()`s them, which needs 22.12+.

**Pin `better-sqlite3` to the 12.x line. Do not bump it to 13.** The runtime image is `node:24-alpine`, which is musl and ships no python/make/g++, so a source build is impossible. `better-sqlite3` must therefore find a prebuilt binary matching both Node's ABI and musl, published as `better-sqlite3-v<ver>-node-v<abi>-linuxmusl-x64.tar.gz`. Node 24 is ABI 137, and only 12.x publishes that asset:

| Version | ABI 137 musl prebuild |
|---|---|
| 11.x | no (this is why Node 24 needs >= 12) |
| 12.11.1 | yes |
| 13.x | no — publishes no prebuilds at all, for any ABI or libc |

Before changing this dependency, check the asset actually exists:

```bash
curl -sI -o /dev/null -w '%{http_code}\n' \
  https://github.com/WiseLibs/better-sqlite3/releases/download/v<ver>/better-sqlite3-v<ver>-node-v137-linuxmusl-x64.tar.gz
```

302 means it exists, 404 means the Docker build will fail at `yarn install` with `gyp ERR! find Python`. Note that a local install on a glibc machine proves nothing about this, and a warm Yarn cache will mask a source build entirely. Verify cold, or just check the URL.

## Architecture

This is a Bluesky ATProto **feed generator** for Navy Fragen content. It surfaces posts containing `fragen.navy` in text or `navyfragen` in image alt text.

### Two independent data pipelines

**1. Jetstream ingestion (write path)**
`JetstreamSubscription` in `src/jetstream.ts` opens a persistent WebSocket to a Jetstream endpoint (`FEEDGEN_SUBSCRIPTION_ENDPOINT`, default `wss://jetstream1.us-east.bsky.network`) with `wantedCollections=app.bsky.feed.post`. Jetstream emits plain JSON and filters server-side, so there is no CAR/CBOR decoding and no `@atproto/repo` dependency. Matching posts are written to the `post` SQLite table; the `time_us` cursor is persisted to `sub_state` every 30 seconds so reconnects resume from the right position.

Note: the raw firehose path (`Subscription` from `@atproto/xrpc-server` + `readCar`) was removed — it had been dead code since the Jetstream switch.

**Liveness.** A half-open TCP connection emits neither `error` nor `close`, so a dead subscription used to look exactly like a quiet one: no logs either way. Jetstream filtered to `app.bsky.feed.post` still carries every post on the network, so 60s of total silence means the socket is dead. A watchdog terminates it and reconnects, and a health line reports event and match counts every 5 minutes *unconditionally*, including when both are zero. Matching posts are genuinely rare (single digits per fortnight), so "no posts indexed today" is normal and is not on its own evidence of a broken subscription. Check the `jetstream:` line before concluding anything about ingestion.

**2. Feed serving (read path)**
Express app exposes `/xrpc/app.bsky.feed.getFeedSkeleton` via the XRPC server from `@atproto/xrpc-server`. The handler in `src/methods/feed-generation.ts` queries the `post` table ordered by `indexedAt DESC`. Results are cached in-process (`src/algos/navyfragen.ts`) with a 2-minute TTL, invalidated early (throttled to once/min) when a matching post arrives.

**Startup backfill** (`FeedGenerator.backfill()` in `src/server.ts`): runs before the server starts listening, then repeats every 6 hours. Calls `app.bsky.feed.searchPosts` for each query term to recover posts missed during downtime. Requires `FEEDGEN_HANDLE` + `FEEDGEN_APP_PASSWORD`; silently skips if absent.

### Lexicons — no local codegen

There is **no** `src/lexicon/` directory. Lexicon schemas and types come straight from `@atproto/api`:

- `createServer(schemas, opts)` in `src/server.ts` builds the XRPC server from `@atproto/api`'s `schemas` export. That package is already loaded for the backfill agent, so this costs no extra memory and the definitions track the package instead of a checked-in snapshot.
- Handlers register by NSID: `server.method(ids.AppBskyFeedGetFeedSkeleton, handler)`.
- Request/response types come from the `AppBskyFeedGetFeedSkeleton` namespace. `ctx.params` is typed loosely as `Params`, so cast it to `QueryParams`; note `limit` is optional on that type even though the lexicon's `default: 50` always fills it at runtime.
- Mount with `app.use(server.router)` — **not** `server.routes`, which omits the XRPC error middleware that renders thrown `XRPCError`s as JSON.

Do not re-introduce `@atproto/lex-cli` codegen; the generated output from the 2023 starter kit is incompatible with current `@atproto/xrpc-server` (`HandlerAuth`, `XRPCReqContext`, and friends were all renamed or removed).

### Adding a new feed algorithm

1. Create `src/algos/<shortname>.ts` exporting `shortname` (≤15 chars) and `handler: (ctx, params) => Promise<{feed, cursor}>`
2. Register it in `src/algos/index.ts`
3. Publish with `yarn publishFeed` (update the shortname in the script)

### Database

Two tables, managed by Kysely migrations in `src/db/migrations.ts`:
- `post (uri PK, cid, indexedAt)` — indexed on `indexedAt`
- `sub_state (service PK, cursor)` — one row per subscription endpoint

**Production requirement:** Set `FEEDGEN_SQLITE_LOCATION` to a path on a persistent volume (e.g. `/data/feed.db`). The default (`:memory:`) and any file path on Railway's ephemeral filesystem are wiped on each deployment.

### Rate limiting layers

1. `express-rate-limit`: 3000 req / 15 min per IP (outermost). `getFeedSkeleton` is called by the AppView server-side, so this per-IP budget is shared across every viewer of the feed rather than being per user. Keep it well above real traffic.
2. `express-slow-down`: delay added after 1000 req / 15 min per IP, capped at 2s. The AppView times out a slow feed generator, so an uncapped ramp produces an empty feed rather than backpressure.
3. Per-DID/IP limiter in `feed-generation.ts`: 100 req/min authenticated, 100 req/min unauthenticated (the unauthenticated bucket is keyed by IP, so it is shared across every viewer behind a given AppView). Trips are logged with the DID (or IP), as are auth failures with the JWT's claimed issuer, so an account-specific failure is visible in the logs.

### Auth

`src/auth.ts` validates the ATProto service-auth JWT on each `getFeedSkeleton` request. DID key resolution calls `plc.directory` and is cached by `MemoryCache` (1h stale TTL, 24h max TTL). Unauthenticated requests are allowed through with `requesterDid = undefined`.

**Auth is not mandatory** (`FEEDGEN_REQUIRE_AUTH` defaults to `false`) and should stay that way unless something makes the response requester-dependent. The skeleton is byte-identical for every caller, so requiring auth adds no privacy and only decides which clients can load the feed at all. Anything that 401s a whole client shows its users a permanently empty feed, which is indistinguishable from the feed being broken.

Two compatibility traps live in this path, both of which produced exactly that:

- **`lxm`.** `verifyJwt` treats a *missing* `lxm` claim as a mismatch, not as "unspecified". That claim postdates the original service-auth spec, so a third-party AppView still minting tokens without it is rejected outright. `validateAuth` passes `null` for the check when the claim is absent and the NSID when it is present, so a wrong `lxm` is still rejected but an absent one is tolerated. `aud` and the signature are always checked.
- **`aud`.** It must equal `FEEDGEN_SERVICE_DID`. If that variable is unset, `src/index.ts` mints a fresh random `did:key` on every boot, so every token fails the audience check after each deploy. Always set it in production.

Auth failures log the JWT's claimed issuer (decoded without verification, diagnostics only) so a client-specific or account-specific failure is visible in the logs.
