import { ReadModel, Trade } from "./projection.js";

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
