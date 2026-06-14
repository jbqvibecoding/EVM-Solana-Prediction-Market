-- Indexer read model (Postgres). The current service keeps this model in memory
-- (see src/projection.ts); this schema is the persistence target for the
-- Postgres adapter. Semantics mirror src/projection.ts exactly.

-- One row per indexed market/condition binding.
CREATE TABLE IF NOT EXISTS conditions (
    condition       TEXT PRIMARY KEY,
    market          TEXT NOT NULL,
    collateral_mint TEXT NOT NULL,
    yes_mint        TEXT NOT NULL,
    no_mint         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS conditions_market_idx ON conditions (market);

-- Resolved outcome per market (0 = YES, 1 = NO).
CREATE TABLE IF NOT EXISTS market_resolutions (
    market          TEXT PRIMARY KEY,
    winning_outcome SMALLINT NOT NULL
);

-- Net outcome shares per (user, market, outcome).
CREATE TABLE IF NOT EXISTS positions (
    "user"   TEXT NOT NULL,
    market   TEXT NOT NULL,
    outcome  SMALLINT NOT NULL,
    shares   NUMERIC NOT NULL DEFAULT 0,
    PRIMARY KEY ("user", market, outcome)
);
CREATE INDEX IF NOT EXISTS positions_user_idx ON positions ("user");

-- Settled trades (from exchange OrdersMatched).
CREATE TABLE IF NOT EXISTS trades (
    signature TEXT NOT NULL,
    slot      BIGINT NOT NULL,
    market    TEXT NOT NULL,
    outcome   SMALLINT NOT NULL,
    buyer     TEXT NOT NULL,
    seller    TEXT NOT NULL,
    shares    NUMERIC NOT NULL,
    cost      NUMERIC NOT NULL,
    fee       NUMERIC NOT NULL,
    PRIMARY KEY (signature, market, buyer, seller)
);
CREATE INDEX IF NOT EXISTS trades_market_idx ON trades (market);
CREATE INDEX IF NOT EXISTS trades_buyer_idx ON trades (buyer);
CREATE INDEX IF NOT EXISTS trades_seller_idx ON trades (seller);

-- Cursor for resumable ingestion.
CREATE TABLE IF NOT EXISTS ingest_cursor (
    id   SMALLINT PRIMARY KEY DEFAULT 1,
    last TEXT
);
