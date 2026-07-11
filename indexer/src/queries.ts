import { ReadModel, Trade } from "./projection.js";

export interface MarketSummary {
  market: string;
  condition: string;
  collateralMint: string;
  yesMint: string;
  noMint: string;
  resolved: boolean;
  winningOutcome: number | null;
  volume: bigint;
}

/** On-chain markets the indexer has seen, with resolution status and volume. */
export function markets(model: ReadModel): MarketSummary[] {
  const out: MarketSummary[] = [];
  for (const meta of model.conditions.values()) {
    const winning = model.marketResolved.get(meta.market);
    out.push({
      market: meta.market,
      condition: meta.condition,
      collateralMint: meta.collateralMint,
      yesMint: meta.yesMint,
      noMint: meta.noMint,
      resolved: winning !== undefined,
      winningOutcome: winning ?? null,
      volume: model.volumeByMarket.get(meta.market) ?? 0n,
    });
  }
  return out;
}

/**
 * Wire shape consumed directly by the frontend /spark listing
 * (prediction-market src/lib/spark-markets.ts SparkMarketListing).
 * `totalUsdcDeposited` carries the current USDC backing the curves.
 */
export interface SparkMarketListing {
  title: string;
  config: {
    marketId: string;
    outcomeCount: number;
    curve: { mNum: string; mDen: string; nNum: string; nDen: string };
    vault: string;
    totalUsdcDeposited: string;
    totalFeesCollected: string;
    status: "active" | "resolved";
    winningOutcome: number | null;
    outcomes: {
      index: number;
      label: string;
      mint: string;
      currentSupply: string;
      usdcInCurve: string;
    }[];
  };
}

/** Spark markets shaped for the frontend listing API. */
export function sparkMarketListings(model: ReadModel): SparkMarketListing[] {
  const out: SparkMarketListing[] = [];
  for (const market of model.sparkMarkets.values()) {
    const outcomes = [...market.outcomes.values()]
      .sort((a, b) => a.outcomeIndex - b.outcomeIndex)
      .map((outcome) => ({
        index: outcome.outcomeIndex,
        label: outcome.label,
        mint: outcome.mint,
        currentSupply: outcome.currentSupply.toString(),
        usdcInCurve: outcome.usdcInCurve.toString(),
      }));
    out.push({
      title: market.title,
      config: {
        marketId: market.marketId,
        outcomeCount: outcomes.length,
        curve: {
          mNum: market.mNum.toString(),
          mDen: market.mDen.toString(),
          nNum: market.nNum.toString(),
          nDen: market.nDen.toString(),
        },
        vault: market.vault,
        totalUsdcDeposited: market.totalUsdcInCurves.toString(),
        totalFeesCollected: market.totalFeesCollected.toString(),
        status: market.status,
        winningOutcome: market.winningOutcome,
        outcomes,
      },
    });
  }
  return out;
}

export interface UserPosition {
  market: string;
  outcome: number;
  shares: bigint;
}

/** Non-zero positions held by a user across markets/outcomes. */
export function userPositions(model: ReadModel, user: string): UserPosition[] {
  const out: UserPosition[] = [];
  for (const [key, shares] of model.positions) {
    if (shares === 0n) continue;
    const [u, market, outcome] = key.split("|");
    if (u !== user) continue;
    out.push({ market: market!, outcome: Number(outcome), shares });
  }
  return out;
}

/** Trades, optionally filtered by market, most recent last. */
export function marketTrades(model: ReadModel, market?: string): Trade[] {
  return market ? model.trades.filter((t) => t.market === market) : model.trades;
}

export interface TraderVolume {
  trader: string;
  volume: bigint;
}

/** Leaderboard by total traded collateral volume (buyer and seller both count). */
export function leaderboardByVolume(model: ReadModel): TraderVolume[] {
  const totals = new Map<string, bigint>();
  for (const t of model.trades) {
    totals.set(t.buyer, (totals.get(t.buyer) ?? 0n) + t.cost);
    totals.set(t.seller, (totals.get(t.seller) ?? 0n) + t.cost);
  }
  return [...totals.entries()]
    .map(([trader, volume]) => ({ trader, volume }))
    .sort((a, b) => (a.volume < b.volume ? 1 : a.volume > b.volume ? -1 : 0));
}
