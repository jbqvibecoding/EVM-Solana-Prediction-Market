import { DecodedEvent } from "./events.js";
import { EventMeta, OUTCOME_NO, OUTCOME_YES } from "./projection.js";
import { SqlExecutor } from "./sql.js";
import { SparkMarketListing } from "./queries.js";
import { Store, StoreMarket, StorePosition, StoreTrade, TraderVolume } from "./store.js";

/**
 * Postgres-backed read-model store. Each event maps to SQL upserts that mirror
 * src/projection.ts exactly. NUMERIC/BIGINT columns come back as strings, so
 * values are parsed to bigint on read.
 *
 * Depends only on the {@link SqlExecutor} interface, so it is unit tested with a
 * fake executor (no live database). pgExecutor.ts provides the real backing.
 */
const UPSERT_POSITION = `
  INSERT INTO positions ("user", market, outcome, shares)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT ("user", market, outcome)
  DO UPDATE SET shares = positions.shares + EXCLUDED.shares`;

// Resolves condition -> market via the conditions table (mirrors conditionMarket).
const UPSERT_POSITION_BY_CONDITION = `
  INSERT INTO positions ("user", market, outcome, shares)
  SELECT $1, market, $3, $4 FROM conditions WHERE condition = $2
  ON CONFLICT ("user", market, outcome)
  DO UPDATE SET shares = positions.shares + EXCLUDED.shares`;

const REDEEM_POSITION = `
  INSERT INTO positions ("user", market, outcome, shares)
  SELECT $1, r.market, r.winning_outcome, $3
  FROM market_resolutions r
  JOIN conditions c ON c.market = r.market
  WHERE c.condition = $2
  ON CONFLICT ("user", market, outcome)
  DO UPDATE SET shares = positions.shares + EXCLUDED.shares`;

const INSERT_TRADE = `
  INSERT INTO trades (signature, slot, market, outcome, buyer, seller, shares, cost, fee)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  ON CONFLICT (signature, market, buyer, seller) DO NOTHING`;

const UPSERT_CONDITION = `
  INSERT INTO conditions (condition, market, collateral_mint, yes_mint, no_mint)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (condition)
  DO UPDATE SET market = EXCLUDED.market, collateral_mint = EXCLUDED.collateral_mint,
               yes_mint = EXCLUDED.yes_mint, no_mint = EXCLUDED.no_mint`;

const UPSERT_RESOLUTION = `
  INSERT INTO market_resolutions (market, winning_outcome)
  SELECT market, $2 FROM conditions WHERE condition = $1
  ON CONFLICT (market) DO UPDATE SET winning_outcome = EXCLUDED.winning_outcome`;

const UPSERT_SPARK_MARKET = `
  INSERT INTO spark_markets (market_id, creator, collateral_mint, vault, title,
                             m_num, m_den, n_num, n_den)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  ON CONFLICT (market_id)
  DO UPDATE SET creator = EXCLUDED.creator, collateral_mint = EXCLUDED.collateral_mint,
               vault = EXCLUDED.vault, title = EXCLUDED.title,
               m_num = EXCLUDED.m_num, m_den = EXCLUDED.m_den,
               n_num = EXCLUDED.n_num, n_den = EXCLUDED.n_den`;

const UPSERT_SPARK_OUTCOME = `
  INSERT INTO spark_outcomes (market_id, outcome_index, label, mint)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (market_id, outcome_index)
  DO UPDATE SET label = EXCLUDED.label, mint = EXCLUDED.mint`;

// Mirrors projection.ts SparkTokensMinted: outcome supply/curve + market totals.
const SPARK_MINT_OUTCOME = `
  UPDATE spark_outcomes
  SET current_supply = current_supply + $3, usdc_in_curve = usdc_in_curve + $4
  WHERE market_id = $1 AND outcome_index = $2`;

const SPARK_MINT_MARKET = `
  UPDATE spark_markets
  SET total_usdc_in_curves = total_usdc_in_curves + $2,
      total_fees_collected = total_fees_collected + $3
  WHERE market_id = $1`;

const SPARK_REDEEM_OUTCOME = `
  UPDATE spark_outcomes
  SET current_supply = current_supply - $3, usdc_in_curve = usdc_in_curve - $4
  WHERE market_id = $1 AND outcome_index = $2`;

const SPARK_REDEEM_MARKET = `
  UPDATE spark_markets
  SET total_usdc_in_curves = total_usdc_in_curves - $2
  WHERE market_id = $1`;

const SPARK_RESOLVE = `
  UPDATE spark_markets
  SET status = 'resolved', winning_outcome = $2
  WHERE market_id = $1`;

const SPARK_CLAIM = `
  UPDATE spark_outcomes o
  SET current_supply = o.current_supply - $2
  FROM spark_markets m
  WHERE m.market_id = $1 AND o.market_id = m.market_id
    AND o.outcome_index = m.winning_outcome`;

const TRADE_COLUMNS = `signature, slot, market, outcome, buyer, seller, shares, cost, fee`;

const LEADERBOARD = `
  SELECT trader, SUM(vol) AS volume FROM (
    SELECT buyer AS trader, cost AS vol FROM trades
    UNION ALL
    SELECT seller AS trader, cost AS vol FROM trades
  ) t
  GROUP BY trader
  ORDER BY volume DESC
  LIMIT $1`;

interface TradeRow {
  signature: string;
  slot: string;
  market: string;
  outcome: number;
  buyer: string;
  seller: string;
  shares: string;
  cost: string;
  fee: string;
}

function mapTrade(r: TradeRow): StoreTrade {
  return {
    signature: r.signature,
    slot: Number(r.slot),
    market: r.market,
    outcome: Number(r.outcome),
    buyer: r.buyer,
    seller: r.seller,
    shares: BigInt(r.shares),
    cost: BigInt(r.cost),
    fee: BigInt(r.fee),
  };
}

export class PgStore implements Store {
  constructor(private readonly sql: SqlExecutor) {}

  async applyEvent(ev: DecodedEvent, meta: EventMeta = {}): Promise<void> {
    switch (ev.type) {
      case "OrdersMatched":
        await this.sql.query(INSERT_TRADE, [
          meta.signature ?? "",
          meta.slot ?? 0,
          ev.market,
          ev.outcome,
          ev.buyer,
          ev.seller,
          ev.shares.toString(),
          ev.cost.toString(),
          ev.fee.toString(),
        ]);
        await this.sql.query(UPSERT_POSITION, [
          ev.buyer,
          ev.market,
          ev.outcome,
          ev.shares.toString(),
        ]);
        await this.sql.query(UPSERT_POSITION, [
          ev.seller,
          ev.market,
          ev.outcome,
          (-ev.shares).toString(),
        ]);
        break;
      case "ConditionInitialized":
        await this.sql.query(UPSERT_CONDITION, [
          ev.condition,
          ev.market,
          ev.collateralMint,
          ev.yesMint,
          ev.noMint,
        ]);
        break;
      case "ConditionResolved":
        await this.sql.query(UPSERT_RESOLUTION, [ev.condition, ev.winningOutcome]);
        break;
      case "SetSplit":
        await this.sql.query(UPSERT_POSITION_BY_CONDITION, [ev.user, ev.condition, OUTCOME_YES, ev.amount.toString()]);
        await this.sql.query(UPSERT_POSITION_BY_CONDITION, [ev.user, ev.condition, OUTCOME_NO, ev.amount.toString()]);
        break;
      case "SetMerged":
        await this.sql.query(UPSERT_POSITION_BY_CONDITION, [ev.user, ev.condition, OUTCOME_YES, (-ev.amount).toString()]);
        await this.sql.query(UPSERT_POSITION_BY_CONDITION, [ev.user, ev.condition, OUTCOME_NO, (-ev.amount).toString()]);
        break;
      case "Redeemed":
        await this.sql.query(REDEEM_POSITION, [ev.user, ev.condition, (-ev.amount).toString()]);
        break;
      case "SparkMarketCreated":
        await this.sql.query(UPSERT_SPARK_MARKET, [
          ev.marketId.toString(),
          ev.creator,
          ev.collateralMint,
          ev.vault,
          ev.title,
          ev.mNum.toString(),
          ev.mDen.toString(),
          ev.nNum.toString(),
          ev.nDen.toString(),
        ]);
        break;
      case "SparkOutcomeAdded":
        await this.sql.query(UPSERT_SPARK_OUTCOME, [
          ev.marketId.toString(),
          ev.outcomeIndex,
          ev.label,
          ev.mint,
        ]);
        break;
      case "SparkTokensMinted": {
        const net = (ev.usdcAmount - ev.fee).toString();
        await this.sql.query(SPARK_MINT_OUTCOME, [
          ev.marketId.toString(),
          ev.outcomeIndex,
          ev.tokensMinted.toString(),
          net,
        ]);
        await this.sql.query(SPARK_MINT_MARKET, [
          ev.marketId.toString(),
          net,
          ev.fee.toString(),
        ]);
        break;
      }
      case "SparkTokensRedeemed":
        await this.sql.query(SPARK_REDEEM_OUTCOME, [
          ev.marketId.toString(),
          ev.outcomeIndex,
          ev.tokensBurned.toString(),
          ev.usdcReturned.toString(),
        ]);
        await this.sql.query(SPARK_REDEEM_MARKET, [
          ev.marketId.toString(),
          ev.usdcReturned.toString(),
        ]);
        break;
      case "SparkMarketResolved":
        await this.sql.query(SPARK_RESOLVE, [ev.marketId.toString(), ev.winningOutcome]);
        break;
      case "SparkWinningsClaimed":
        await this.sql.query(SPARK_CLAIM, [ev.marketId.toString(), ev.tokensBurned.toString()]);
        break;
      case "SparkFeesCollected":
        // Fee accrual is tracked at mint time; the treasury sweep does not
        // change the read model.
        break;
    }
  }

  async getMarkets(): Promise<StoreMarket[]> {
    const rows = await this.sql.query<{
      market: string;
      condition: string;
      collateral_mint: string;
      yes_mint: string;
      no_mint: string;
      winning_outcome: number | null;
      volume: string;
    }>(
      `SELECT c.condition, c.market, c.collateral_mint, c.yes_mint, c.no_mint,
              r.winning_outcome,
              COALESCE((SELECT SUM(cost) FROM trades t WHERE t.market = c.market), 0) AS volume
       FROM conditions c
       LEFT JOIN market_resolutions r ON r.market = c.market
       ORDER BY c.market`,
    );
    return rows.map((r) => ({
      market: r.market,
      condition: r.condition,
      collateralMint: r.collateral_mint,
      yesMint: r.yes_mint,
      noMint: r.no_mint,
      resolved: r.winning_outcome !== null,
      winningOutcome: r.winning_outcome === null ? null : Number(r.winning_outcome),
      volume: BigInt(r.volume),
    }));
  }

  async getSparkMarkets(): Promise<SparkMarketListing[]> {
    const markets = await this.sql.query<{
      market_id: string;
      title: string;
      vault: string;
      m_num: string;
      m_den: string;
      n_num: string;
      n_den: string;
      status: string;
      winning_outcome: number | null;
      total_usdc_in_curves: string;
      total_fees_collected: string;
    }>(
      `SELECT market_id, title, vault, m_num, m_den, n_num, n_den, status,
              winning_outcome, total_usdc_in_curves, total_fees_collected
       FROM spark_markets ORDER BY market_id`,
    );
    const outcomes = await this.sql.query<{
      market_id: string;
      outcome_index: number;
      label: string;
      mint: string;
      current_supply: string;
      usdc_in_curve: string;
    }>(
      `SELECT market_id, outcome_index, label, mint, current_supply, usdc_in_curve
       FROM spark_outcomes ORDER BY market_id, outcome_index`,
    );

    const outcomesByMarket = new Map<string, typeof outcomes>();
    for (const o of outcomes) {
      const list = outcomesByMarket.get(o.market_id) ?? [];
      list.push(o);
      outcomesByMarket.set(o.market_id, list);
    }

    return markets.map((m) => {
      const marketOutcomes = outcomesByMarket.get(m.market_id) ?? [];
      return {
        title: m.title,
        config: {
          marketId: m.market_id,
          outcomeCount: marketOutcomes.length,
          curve: { mNum: m.m_num, mDen: m.m_den, nNum: m.n_num, nDen: m.n_den },
          vault: m.vault,
          totalUsdcDeposited: m.total_usdc_in_curves,
          totalFeesCollected: m.total_fees_collected,
          status: m.status === "resolved" ? "resolved" : "active",
          winningOutcome: m.winning_outcome === null ? null : Number(m.winning_outcome),
          outcomes: marketOutcomes.map((o) => ({
            index: Number(o.outcome_index),
            label: o.label,
            mint: o.mint,
            currentSupply: o.current_supply,
            usdcInCurve: o.usdc_in_curve,
          })),
        },
      };
    });
  }

  async getPositions(user: string): Promise<StorePosition[]> {
    const rows = await this.sql.query<{ market: string; outcome: number; shares: string }>(
      `SELECT market, outcome, shares FROM positions WHERE "user" = $1 AND shares <> 0`,
      [user],
    );
    return rows.map((r) => ({
      market: r.market,
      outcome: Number(r.outcome),
      shares: BigInt(r.shares),
    }));
  }

  async getVolume(market: string): Promise<bigint> {
    const rows = await this.sql.query<{ volume: string }>(
      `SELECT COALESCE(SUM(cost), 0) AS volume FROM trades WHERE market = $1`,
      [market],
    );
    return BigInt(rows[0]?.volume ?? "0");
  }

  async getTrades(market?: string): Promise<StoreTrade[]> {
    const rows = market
      ? await this.sql.query<TradeRow>(
          `SELECT ${TRADE_COLUMNS} FROM trades WHERE market = $1 ORDER BY slot ASC`,
          [market],
        )
      : await this.sql.query<TradeRow>(`SELECT ${TRADE_COLUMNS} FROM trades ORDER BY slot ASC`);
    return rows.map(mapTrade);
  }

  async getLeaderboard(limit = 100): Promise<TraderVolume[]> {
    const rows = await this.sql.query<{ trader: string; volume: string }>(LEADERBOARD, [limit]);
    return rows.map((r) => ({ trader: r.trader, volume: BigInt(r.volume) }));
  }

  async getCursor(): Promise<string | null> {
    const rows = await this.sql.query<{ last: string | null }>(
      `SELECT last FROM ingest_cursor WHERE id = 1`,
    );
    return rows[0]?.last ?? null;
  }

  async setCursor(signature: string | null): Promise<void> {
    await this.sql.query(
      `INSERT INTO ingest_cursor (id, last) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET last = EXCLUDED.last`,
      [signature],
    );
  }
}
