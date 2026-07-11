import { DecodedEvent } from "./events.js";
import { EventMeta } from "./projection.js";
import { SparkMarketListing } from "./queries.js";

/**
 * Persistent read-model store. The in-memory model (projection.ts) and the
 * Postgres store (pgStore.ts) apply identical event semantics; this is the
 * async interface the DB-backed read API and ingest loop depend on.
 */
export interface StorePosition {
  market: string;
  outcome: number;
  shares: bigint;
}

export interface StoreTrade {
  market: string;
  outcome: number;
  buyer: string;
  seller: string;
  shares: bigint;
  cost: bigint;
  fee: bigint;
  signature: string;
  slot: number;
}

export interface TraderVolume {
  trader: string;
  volume: bigint;
}

export interface StoreMarket {
  market: string;
  condition: string;
  collateralMint: string;
  yesMint: string;
  noMint: string;
  resolved: boolean;
  winningOutcome: number | null;
  volume: bigint;
}

export interface Store {
  applyEvent(ev: DecodedEvent, meta?: EventMeta): Promise<void>;
  getMarkets(): Promise<StoreMarket[]>;
  /** Spark markets pre-shaped as frontend SparkMarketListing objects. */
  getSparkMarkets(): Promise<SparkMarketListing[]>;
  getPositions(user: string): Promise<StorePosition[]>;
  getVolume(market: string): Promise<bigint>;
  getTrades(market?: string): Promise<StoreTrade[]>;
  getLeaderboard(limit?: number): Promise<TraderVolume[]>;
  getCursor(): Promise<string | null>;
  setCursor(signature: string | null): Promise<void>;
}
