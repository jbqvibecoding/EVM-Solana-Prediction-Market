import { MatchingEngine } from "./engine.js";
import { Match } from "./orderbook.js";
import { Order, orderId } from "./order.js";

/** JSON-safe order representation (bigints as decimal strings). */
export interface WireOrder {
  salt: string;
  maker: string;
  market: string;
  outcome: number;
  side: number;
  makerAmount: string;
  takerAmount: string;
  expiration: string;
  feeRateBps: number;
}

export function toWireOrder(o: Order): WireOrder {
  return {
    salt: o.salt.toString(),
    maker: o.maker,
    market: o.market,
    outcome: o.outcome,
    side: o.side,
    makerAmount: o.makerAmount.toString(),
    takerAmount: o.takerAmount.toString(),
    expiration: o.expiration.toString(),
    feeRateBps: o.feeRateBps,
  };
}

export function parseOrder(w: WireOrder): Order {
  return {
    salt: BigInt(w.salt),
    maker: w.maker,
    market: w.market,
    outcome: w.outcome,
    side: w.side,
    makerAmount: BigInt(w.makerAmount),
    takerAmount: BigInt(w.takerAmount),
    expiration: BigInt(w.expiration),
    feeRateBps: w.feeRateBps,
  };
}

function wireMatch(m: Match) {
  return {
    buy: toWireOrder(m.buy),
    sell: toWireOrder(m.sell),
    shares: m.shares.toString(),
    cost: m.cost.toString(),
  };
}

export interface ApiRequest {
  method: string;
  path: string;
  query: Record<string, string | undefined>;
  body: unknown;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

/**
 * Framework-free router over the matching engine. The HTTP server is a thin
 * wrapper around this so the routing logic stays unit-testable.
 *
 * Endpoints (shaped to mirror Kuest's CLOB client):
 *   GET  /health
 *   POST /order                  { order: WireOrder, signature: base64 }
 *   POST /order/:id/cancel
 *   GET  /orderbook?market&outcome
 *   GET  /prices?market&outcome
 */
export async function handleRequest(
  engine: MatchingEngine,
  req: ApiRequest,
): Promise<ApiResponse> {
  try {
    if (req.method === "GET" && req.path === "/health") {
      return { status: 200, body: { ok: true } };
    }

    if (req.method === "POST" && req.path === "/order") {
      const body = req.body as { order?: WireOrder; signature?: string };
      if (!body?.order || !body?.signature) {
        return { status: 400, body: { error: "order and signature required" } };
      }
      const order = parseOrder(body.order);
      const signature = new Uint8Array(Buffer.from(body.signature, "base64"));
      const result = await engine.submit({ order, signature });
      return {
        status: 200,
        body: {
          id: orderId(order),
          matches: result.matches.map(wireMatch),
          settlements: result.settlements,
        },
      };
    }

    if (req.method === "POST" && req.path.endsWith("/cancel")) {
      // /order/:id/cancel
      const parts = req.path.split("/");
      const id = decodeURIComponent(parts[parts.length - 2] ?? "");
      if (!id) return { status: 400, body: { error: "order id required" } };
      const ok = engine.cancel(id);
      return { status: ok ? 200 : 404, body: { cancelled: ok } };
    }

    if (req.method === "GET" && req.path === "/orderbook") {
      const market = req.query.market;
      const outcome = Number(req.query.outcome ?? "0");
      if (!market) return { status: 400, body: { error: "market required" } };
      const ob = engine.orderBook(market, outcome);
      return {
        status: 200,
        body: {
          bids: ob.bids.map(toWireOrder),
          asks: ob.asks.map(toWireOrder),
        },
      };
    }

    if (req.method === "GET" && req.path === "/prices") {
      const market = req.query.market;
      const outcome = Number(req.query.outcome ?? "0");
      if (!market) return { status: 400, body: { error: "market required" } };
      return { status: 200, body: engine.prices(market, outcome) };
    }

    return { status: 404, body: { error: "not found" } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "internal error";
    return { status: 400, body: { error: message } };
  }
}
