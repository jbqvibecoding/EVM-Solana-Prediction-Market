import { ReadModel, Trade, getVolume } from "./projection.js";
import { MarketSummary, leaderboardByVolume, marketTrades, markets, userPositions } from "./queries.js";

export interface ApiRequest {
  method: string;
  path: string;
  query: Record<string, string | undefined>;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

function wireMarket(m: MarketSummary) {
  return {
    market: m.market,
    condition: m.condition,
    collateralMint: m.collateralMint,
    yesMint: m.yesMint,
    noMint: m.noMint,
    resolved: m.resolved,
    winningOutcome: m.winningOutcome,
    volume: m.volume.toString(),
  };
}

function wireTrade(t: Trade) {
  return {
    market: t.market,
    outcome: t.outcome,
    buyer: t.buyer,
    seller: t.seller,
    shares: t.shares.toString(),
    cost: t.cost.toString(),
    fee: t.fee.toString(),
    signature: t.signature,
    slot: t.slot,
  };
}

/**
 * Read-only query API over the indexer's read model. Mirrors the data Kuest
 * fetched from its external DATA_URL/USER_PNL_URL services.
 *
 *   GET /health
 *   GET /positions?user
 *   GET /volume?market
 *   GET /trades?market
 *   GET /leaderboard
 */
export function handleRequest(model: ReadModel, req: ApiRequest): ApiResponse {
  if (req.method !== "GET") return { status: 405, body: { error: "method not allowed" } };

  if (req.path === "/health") return { status: 200, body: { ok: true } };

  if (req.path === "/markets") {
    return { status: 200, body: markets(model).map(wireMarket) };
  }

  if (req.path === "/positions") {
    const user = req.query.user;
    if (!user) return { status: 400, body: { error: "user required" } };
    return {
      status: 200,
      body: userPositions(model, user).map((p) => ({
        market: p.market,
        outcome: p.outcome,
        shares: p.shares.toString(),
      })),
    };
  }

  if (req.path === "/volume") {
    const market = req.query.market;
    if (!market) return { status: 400, body: { error: "market required" } };
    return { status: 200, body: { market, volume: getVolume(model, market).toString() } };
  }

  if (req.path === "/trades") {
    return {
      status: 200,
      body: marketTrades(model, req.query.market).map(wireTrade),
    };
  }

  if (req.path === "/leaderboard") {
    return {
      status: 200,
      body: leaderboardByVolume(model).map((e) => ({
        trader: e.trader,
        volume: e.volume.toString(),
      })),
    };
  }

  return { status: 404, body: { error: "not found" } };
}
