-- Spark (events_futures) market projection. Applied out of band like 0001.
-- Rebuilt purely from program events; numeric columns mirror the on-chain
-- SparkMarket / OutcomePool account fields (base units).

CREATE TABLE IF NOT EXISTS spark_markets (
    market_id            TEXT PRIMARY KEY,
    creator              TEXT NOT NULL,
    collateral_mint      TEXT NOT NULL,
    vault                TEXT NOT NULL,
    title                TEXT NOT NULL,
    m_num                NUMERIC NOT NULL,
    m_den                NUMERIC NOT NULL,
    n_num                NUMERIC NOT NULL,
    n_den                NUMERIC NOT NULL,
    status               TEXT NOT NULL DEFAULT 'active',
    winning_outcome      INTEGER,
    total_usdc_in_curves NUMERIC NOT NULL DEFAULT 0,
    total_fees_collected NUMERIC NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS spark_outcomes (
    market_id       TEXT NOT NULL,
    outcome_index   INTEGER NOT NULL,
    label           TEXT NOT NULL,
    mint            TEXT NOT NULL,
    current_supply  NUMERIC NOT NULL DEFAULT 0,
    usdc_in_curve   NUMERIC NOT NULL DEFAULT 0,
    PRIMARY KEY (market_id, outcome_index)
);
