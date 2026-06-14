# matching-engine

Off-chain order matching engine for the Solana prediction-market CLOB. It
replaces Kuest's hosted CLOB service (`CLOB_URL`): it accepts maker-signed
orders, maintains the order book, matches crossing orders, and settles each
match atomically on-chain via the `exchange` program.

## Architecture

```
client (Kuest)  --signed order-->  matching-engine  --match_orders tx-->  exchange program
                                         |                                      |
                                    order book                          conditional_token
```

- **order.ts** — `Order` type and `serializeOrder()`, the exact 100-byte borsh
  layout of `exchange::state::Order`. Makers sign these bytes; the chain
  re-derives and compares them, so byte parity is mandatory.
- **orderbook.ts** — in-memory CLOB, price-then-time priority. Full-fill,
  equal-share matches only (matching the current on-chain `match_orders`).
- **settlement.ts** — builds `[ed25519(buy), ed25519(sell), match_orders]`,
  Anchor discriminator + borsh args, PDA/ATA derivation, outcome mint derived
  from `(market, outcome)` via the conditional_token PDAs.
- **engine.ts** — validates signatures/expiry, drives the book, and invokes a
  `Settler` per match.
- **solanaSettler.ts** — submits the settlement tx; the operator pays fees so
  makers trade gas-free (the exchange PDA is a pre-approved SPL delegate).
- **api.ts / server.ts** — framework-free HTTP API.

## API

| Method | Path | Body / Query | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | – | liveness |
| POST | `/order` | `{ order: WireOrder, signature: base64 }` | submit a signed order |
| POST | `/order/:id/cancel` | – | cancel a resting order |
| GET | `/orderbook` | `?market&outcome` | resting bids/asks |
| GET | `/prices` | `?market&outcome` | best bid/ask |

`WireOrder` is `Order` with bigint fields (`salt`, `makerAmount`, `takerAmount`,
`expiration`) as decimal strings.

## Develop

```bash
npm install
npm run typecheck
npm test          # vitest
npm run build     # tsc -> dist/
```

### Run

Requires a deployed `exchange` + `conditional_token` and a funded operator:

```bash
RPC_URL=... \
EXCHANGE_PROGRAM_ID=... \
CONDITIONAL_TOKEN_PROGRAM_ID=... \
COLLATERAL_MINT=... \
FEE_AUTHORITY=... \
OPERATOR_SECRET_KEY='[...]' \
PORT=9100 \
node --experimental-strip-types src/server.ts   # or run the built dist/
```

## Status / next

- Matching is full-fill, equal-share only; **partial fills** and complementary
  **mint/merge** matches (BUY+BUY, SELL+SELL) are not yet implemented.
- The order book is in-memory (not persisted) and single-process.
- Makers must `approve` the exchange PDA as an SPL delegate before trading.
