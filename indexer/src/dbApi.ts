import { ApiRequest, ApiResponse } from "./api.js";
import { Store, StoreTrade } from "./store.js";

function wireTrade(t: StoreTrade) {
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
 * DB-backed counterpart of api.ts handleRequest — same routes and JSON shapes,
 * but reads from a {@link Store} (Postgres) instead of the in-memory model.
 *
 *   GET /health
 *   GET /positions?user
 *   GET /volume?market
 *   GET /trades?market
 *   GET /leaderboard
 */
export async function handleDbRequest(store: Store, req: ApiRequest): Promise<ApiResponse> {
  if (req.method !== "GET") return { status: 405, body: { error: "method not allowed" } };

  if (req.path === "/health") return { status: 200, body: { ok: true } };

  if (req.path === "/positions") {
    const user = req.query.user;
    if (!user) return { status: 400, body: { error: "user required" } };
    const positions = await store.getPositions(user);
    return {
      status: 200,
      body: positions.map((p) => ({
        market: p.market,
        outcome: p.outcome,
        shares: p.shares.toString(),
      })),
    };
  }

  if (req.path === "/volume") {
    const market = req.query.market;
    if (!market) return { status: 400, body: { error: "market required" } };
    const volume = await store.getVolume(market);
    return { status: 200, body: { market, volume: volume.toString() } };
  }

  if (req.path === "/trades") {
    const trades = await store.getTrades(req.query.market);
    return { status: 200, body: trades.map(wireTrade) };
  }

  if (req.path === "/leaderboard") {
    const entries = await store.getLeaderboard();
    return {
      status: 200,
      body: entries.map((e) => ({ trader: e.trader, volume: e.volume.toString() })),
    };
  }

  return { status: 404, body: { error: "not found" } };
}
