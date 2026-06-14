import {
  Order,
  SIDE_BUY,
  SIDE_SELL,
  orderId,
  orderPrice,
  orderShares,
} from "./order.js";

export interface RestingOrder {
  order: Order;
  /** monotonic sequence for time priority */
  seq: number;
}

/** A matched pair ready to be settled on-chain via `exchange::match_orders`. */
export interface Match {
  buy: Order;
  sell: Order;
  shares: bigint;
  /** collateral the buyer pays, executed at the resting (maker) price */
  cost: bigint;
}

function bookKey(market: string, outcome: number): string {
  return `${market}:${outcome}`;
}

/**
 * In-memory central limit order book.
 *
 * The on-chain `match_orders` instruction currently settles only full fills of
 * equal share quantity, so the engine matches a taker order against a resting
 * opposite order with the *same* share amount and a crossing price, using
 * price-then-time priority. Partial fills are intentionally not produced yet.
 */
export class OrderBook {
  private bids = new Map<string, RestingOrder[]>();
  private asks = new Map<string, RestingOrder[]>();
  private index = new Map<string, { key: string; side: number }>();
  private seq = 0;

  private side(side: number): Map<string, RestingOrder[]> {
    return side === SIDE_BUY ? this.bids : this.asks;
  }

  /** Resting orders on one side of a market/outcome (read-only copy). */
  resting(market: string, outcome: number, side: number): Order[] {
    const list = this.side(side).get(bookKey(market, outcome)) ?? [];
    return list.map((r) => r.order);
  }

  /**
   * Submit an order. Returns any matches it produced. If unmatched, the order
   * rests in the book. Throws on a duplicate order id.
   */
  submit(order: Order): Match[] {
    const id = orderId(order);
    if (this.index.has(id)) {
      throw new Error(`duplicate order ${id}`);
    }

    const key = bookKey(order.market, order.outcome);
    const oppositeSide = order.side === SIDE_BUY ? SIDE_SELL : SIDE_BUY;
    const opposite = this.side(oppositeSide).get(key) ?? [];

    const shares = orderShares(order);
    const price = orderPrice(order);

    // Candidate resting orders with identical share size and crossing price.
    const candidates = opposite
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => orderShares(r.order) === shares)
      .filter(({ r }) => {
        const restPrice = orderPrice(r.order);
        return order.side === SIDE_BUY ? restPrice <= price : restPrice >= price;
      });

    if (candidates.length > 0) {
      // Best price first (lowest ask for a buy, highest bid for a sell),
      // then earliest (lowest seq) for time priority.
      candidates.sort((a, b) => {
        const pa = orderPrice(a.r.order);
        const pb = orderPrice(b.r.order);
        if (pa !== pb) {
          return order.side === SIDE_BUY ? pa - pb : pb - pa;
        }
        return a.r.seq - b.r.seq;
      });

      const best = candidates[0]!;
      // Remove the resting order that we matched against.
      opposite.splice(best.i, 1);
      this.index.delete(orderId(best.r.order));

      const buy = order.side === SIDE_BUY ? order : best.r.order;
      const sell = order.side === SIDE_SELL ? order : best.r.order;
      // Executed at the resting order's (maker's) price.
      const maker = best.r.order;
      const cost = maker.side === SIDE_SELL ? maker.takerAmount : maker.makerAmount;

      return [{ buy, sell, shares, cost }];
    }

    // No match: rest the order.
    const list = this.side(order.side).get(key) ?? [];
    list.push({ order, seq: this.seq++ });
    this.side(order.side).set(key, list);
    this.index.set(id, { key, side: order.side });
    return [];
  }

  /** Cancel a resting order. Returns true if it was present. */
  cancel(id: string): boolean {
    const loc = this.index.get(id);
    if (!loc) return false;
    const list = this.side(loc.side).get(loc.key) ?? [];
    const idx = list.findIndex((r) => orderId(r.order) === id);
    if (idx >= 0) list.splice(idx, 1);
    this.index.delete(id);
    return true;
  }

  /** Best bid / best ask prices for a market/outcome, if any. */
  topOfBook(
    market: string,
    outcome: number,
  ): { bid: number | null; ask: number | null } {
    const bids = this.bids.get(bookKey(market, outcome)) ?? [];
    const asks = this.asks.get(bookKey(market, outcome)) ?? [];
    const bid = bids.length
      ? Math.max(...bids.map((r) => orderPrice(r.order)))
      : null;
    const ask = asks.length
      ? Math.min(...asks.map((r) => orderPrice(r.order)))
      : null;
    return { bid, ask };
  }
}
