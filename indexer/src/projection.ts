import { DecodedEvent } from "./events.js";

export const OUTCOME_YES = 0;
export const OUTCOME_NO = 1;

export interface Trade {
  market: string;
  outcome: number;
  buyer: string;
  seller: string;
  shares: bigint;
  cost: bigint;
  fee: bigint;
  signature?: string;
  slot?: number;
}

/** On-chain market metadata from ConditionInitialized (keyed by condition). */
export interface ConditionMeta {
  condition: string;
  market: string;
  collateralMint: string;
  yesMint: string;
  noMint: string;
}

/** One spark (events_futures) outcome pool, rebuilt from events. */
export interface SparkOutcomeModel {
  outcomeIndex: number;
  label: string;
  mint: string;
  currentSupply: bigint;
  usdcInCurve: bigint;
}

/**
 * One spark market, rebuilt from events. The reducer applies the exact same
 * integer updates as the on-chain handlers (mint adds net = amount − fee,
 * redeem subtracts proceeds, claim burns winning supply), so this matches the
 * SparkMarket/OutcomePool accounts.
 */
export interface SparkMarketModel {
  marketId: string;
  creator: string;
  collateralMint: string;
  vault: string;
  title: string;
  mNum: bigint;
  mDen: bigint;
  nNum: bigint;
  nDen: bigint;
  status: "active" | "resolved";
  winningOutcome: number | null;
  totalUsdcInCurves: bigint;
  totalFeesCollected: bigint;
  outcomes: Map<number, SparkOutcomeModel>;
}

/**
 * In-memory read model derived purely from program events. The Postgres adapter
 * (pgStore.ts) applies the same semantics as SQL upserts.
 *
 * Position keys are `${user}|${market}|${outcome}` holding net outcome shares.
 */
export interface ReadModel {
  trades: Trade[];
  volumeByMarket: Map<string, bigint>;
  positions: Map<string, bigint>;
  /** condition account -> market */
  conditionMarket: Map<string, string>;
  /** condition account -> on-chain market metadata */
  conditions: Map<string, ConditionMeta>;
  /** market -> winning outcome (once resolved) */
  marketResolved: Map<string, number>;
  /** spark market id (decimal string) -> spark market model */
  sparkMarkets: Map<string, SparkMarketModel>;
}

export function emptyModel(): ReadModel {
  return {
    trades: [],
    volumeByMarket: new Map(),
    positions: new Map(),
    conditionMarket: new Map(),
    conditions: new Map(),
    marketResolved: new Map(),
    sparkMarkets: new Map(),
  };
}

function positionKey(user: string, market: string, outcome: number): string {
  return `${user}|${market}|${outcome}`;
}

function addPosition(
  model: ReadModel,
  user: string,
  market: string,
  outcome: number,
  delta: bigint,
): void {
  const key = positionKey(user, market, outcome);
  model.positions.set(key, (model.positions.get(key) ?? 0n) + delta);
}

export function getPosition(
  model: ReadModel,
  user: string,
  market: string,
  outcome: number,
): bigint {
  return model.positions.get(positionKey(user, market, outcome)) ?? 0n;
}

export function getVolume(model: ReadModel, market: string): bigint {
  return model.volumeByMarket.get(market) ?? 0n;
}

export interface EventMeta {
  signature?: string;
  slot?: number;
}

export function applyEvent(
  model: ReadModel,
  ev: DecodedEvent,
  meta: EventMeta = {},
): void {
  switch (ev.type) {
    case "OrdersMatched": {
      model.trades.push({
        market: ev.market,
        outcome: ev.outcome,
        buyer: ev.buyer,
        seller: ev.seller,
        shares: ev.shares,
        cost: ev.cost,
        fee: ev.fee,
        signature: meta.signature,
        slot: meta.slot,
      });
      model.volumeByMarket.set(
        ev.market,
        (model.volumeByMarket.get(ev.market) ?? 0n) + ev.cost,
      );
      addPosition(model, ev.buyer, ev.market, ev.outcome, ev.shares);
      addPosition(model, ev.seller, ev.market, ev.outcome, -ev.shares);
      break;
    }
    case "ConditionInitialized": {
      model.conditionMarket.set(ev.condition, ev.market);
      model.conditions.set(ev.condition, {
        condition: ev.condition,
        market: ev.market,
        collateralMint: ev.collateralMint,
        yesMint: ev.yesMint,
        noMint: ev.noMint,
      });
      break;
    }
    case "ConditionResolved": {
      const market = model.conditionMarket.get(ev.condition);
      if (market) model.marketResolved.set(market, ev.winningOutcome);
      break;
    }
    case "SetSplit": {
      const market = model.conditionMarket.get(ev.condition);
      if (market) {
        addPosition(model, ev.user, market, OUTCOME_YES, ev.amount);
        addPosition(model, ev.user, market, OUTCOME_NO, ev.amount);
      }
      break;
    }
    case "SetMerged": {
      const market = model.conditionMarket.get(ev.condition);
      if (market) {
        addPosition(model, ev.user, market, OUTCOME_YES, -ev.amount);
        addPosition(model, ev.user, market, OUTCOME_NO, -ev.amount);
      }
      break;
    }
    case "Redeemed": {
      const market = model.conditionMarket.get(ev.condition);
      if (market === undefined) break;
      const winning = model.marketResolved.get(market);
      if (winning === undefined) break;
      addPosition(model, ev.user, market, winning, -ev.amount);
      break;
    }
    case "SparkMarketCreated": {
      const id = ev.marketId.toString();
      model.sparkMarkets.set(id, {
        marketId: id,
        creator: ev.creator,
        collateralMint: ev.collateralMint,
        vault: ev.vault,
        title: ev.title,
        mNum: ev.mNum,
        mDen: ev.mDen,
        nNum: ev.nNum,
        nDen: ev.nDen,
        status: "active",
        winningOutcome: null,
        totalUsdcInCurves: 0n,
        totalFeesCollected: 0n,
        outcomes: new Map(),
      });
      break;
    }
    case "SparkOutcomeAdded": {
      const market = model.sparkMarkets.get(ev.marketId.toString());
      if (!market) break;
      market.outcomes.set(ev.outcomeIndex, {
        outcomeIndex: ev.outcomeIndex,
        label: ev.label,
        mint: ev.mint,
        currentSupply: 0n,
        usdcInCurve: 0n,
      });
      break;
    }
    case "SparkTokensMinted": {
      const market = model.sparkMarkets.get(ev.marketId.toString());
      const outcome = market?.outcomes.get(ev.outcomeIndex);
      if (!market || !outcome) break;
      const net = ev.usdcAmount - ev.fee;
      outcome.currentSupply += ev.tokensMinted;
      outcome.usdcInCurve += net;
      market.totalUsdcInCurves += net;
      market.totalFeesCollected += ev.fee;
      break;
    }
    case "SparkTokensRedeemed": {
      const market = model.sparkMarkets.get(ev.marketId.toString());
      const outcome = market?.outcomes.get(ev.outcomeIndex);
      if (!market || !outcome) break;
      outcome.currentSupply -= ev.tokensBurned;
      outcome.usdcInCurve -= ev.usdcReturned;
      market.totalUsdcInCurves -= ev.usdcReturned;
      break;
    }
    case "SparkMarketResolved": {
      const market = model.sparkMarkets.get(ev.marketId.toString());
      if (!market) break;
      market.status = "resolved";
      market.winningOutcome = ev.winningOutcome;
      break;
    }
    case "SparkWinningsClaimed": {
      const market = model.sparkMarkets.get(ev.marketId.toString());
      if (!market || market.winningOutcome === null) break;
      const outcome = market.outcomes.get(market.winningOutcome);
      if (!outcome) break;
      outcome.currentSupply -= ev.tokensBurned;
      break;
    }
    case "SparkFeesCollected": {
      // Fee accrual is tracked at mint time; the sweep to the treasury does
      // not change the read model (fees remain "collected").
      break;
    }
  }
}

export function applyEvents(
  model: ReadModel,
  events: DecodedEvent[],
  meta: EventMeta = {},
): void {
  for (const ev of events) applyEvent(model, ev, meta);
}
