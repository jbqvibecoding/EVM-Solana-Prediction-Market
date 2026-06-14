# indexer

On-chain event indexer for the Solana prediction-market CLOB. It tails the
`exchange` and `conditional_token` programs, decodes their events, and projects
a read model (positions, volume, trades, resolution, leaderboard) that backs
Kuest's data views — replacing Kuest's external `DATA_URL` / `USER_PNL_URL`.

## Pipeline

```
RPC (getSignaturesForAddress + getTransaction)
  -> rpcSource (LogSource)
  -> ingest loop
  -> events.decodeProgramDataLogs  (Anchor "Program data:" -> typed events)
  -> projection.applyEvents        (pure reducer -> read model)
  -> api (HTTP queries)
```

- **events.ts** — decode Anchor events (discriminator = sha256("event:Name")[..8]
  + borsh) for `OrdersMatched`, `ConditionInitialized/Resolved`, `SetSplit`,
  `SetMerged`, `Redeemed`.
- **projection.ts** — pure reducer into trades, per-market volume, net
  per-(user,market,outcome) positions, condition→market map, resolved outcomes.
- **queries.ts / api.ts** — read API over the model.
- **ingest.ts / rpcSource.ts / server.ts** — polling ingestion + HTTP server.
- **migrations/0001_init.sql** — Postgres persistence target (the Postgres
  adapter is the next slice; the running service currently holds the model in
  memory).

## API

| Method | Path | Query | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | – | liveness |
| GET | `/positions` | `?user` | user's non-zero positions |
| GET | `/volume` | `?market` | market traded volume |
| GET | `/trades` | `?market` (optional) | settled trades |
| GET | `/leaderboard` | – | traders by total volume |

## Develop

```bash
npm install
npm run typecheck
npm test

RPC_URL=... EXCHANGE_PROGRAM_ID=... CONDITIONAL_TOKEN_PROGRAM_ID=... \
PORT=9200 node --experimental-strip-types src/server.ts
```

## Status / next

- Read model is in memory; the Postgres adapter (per `migrations/0001_init.sql`)
  is the next slice, applying the same projection semantics as SQL upserts.
- PnL is volume-based for now; mark-to-market PnL needs current prices from the
  matching engine (cross-service) and is future work.
