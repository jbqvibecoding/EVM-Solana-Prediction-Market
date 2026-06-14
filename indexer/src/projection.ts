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

/**
 * In-memory read model derived purely from program events. The Postgres adapter
 * (next slice) applies the same semantics as SQL upserts.
 *
 * Position keys are `${user}|${market}|${outcome}` holding net outcome shares.
 */
export interface ReadModel {
  trades: Trade[];
  volumeByMarket: Map<string, bigint>;
  positions: Map<string, bigint>;
  /** condition account -> market */
  conditionMarket: Map<string, string>;
  /** market -> winning outcome (once resolved) */
  marketResolved: Map<string, number>;
}

export function emptyModel(): ReadModel {
  return {
    trades: [],
    volumeByMarket: new Map(),
    positions: new Map(),
    conditionMarket: new Map(),
    marketResolved: new Map(),
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
  }
}

export function applyEvents(
  model: ReadModel,
  events: DecodedEvent[],
  meta: EventMeta = {},
): void {
  for (const ev of events) applyEvent(model, ev, meta);
}
