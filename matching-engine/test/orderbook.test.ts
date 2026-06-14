import { beforeEach, describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { OrderBook } from "../src/orderbook.js";
import { Order, SIDE_BUY, SIDE_SELL } from "../src/order.js";

const MARKET = Keypair.generate().publicKey.toBase58();

function maker(): string {
  return Keypair.generate().publicKey.toBase58();
}

function buy(over: Partial<Order> = {}): Order {
  return {
    salt: BigInt(Math.floor(Math.random() * 1e9)),
    maker: maker(),
    market: MARKET,
    outcome: 0,
    side: SIDE_BUY,
    makerAmount: 70n, // pays 70 collateral
    takerAmount: 100n, // for 100 shares -> price 0.7
    expiration: 0n,
    feeRateBps: 0,
    ...over,
  };
}

function sell(over: Partial<Order> = {}): Order {
  return {
    salt: BigInt(Math.floor(Math.random() * 1e9)),
    maker: maker(),
    market: MARKET,
    outcome: 0,
    side: SIDE_SELL,
    makerAmount: 100n, // gives 100 shares
    takerAmount: 60n, // wants 60 collateral -> price 0.6
    expiration: 0n,
    feeRateBps: 0,
    ...over,
  };
}

describe("OrderBook matching", () => {
  let book: OrderBook;
  beforeEach(() => {
    book = new OrderBook();
  });

  it("matches a crossing buy against a resting sell at the maker price", () => {
    const s = sell();
    expect(book.submit(s)).toHaveLength(0); // rests

    const b = buy();
    const matches = book.submit(b);
    expect(matches).toHaveLength(1);
    const m = matches[0]!;
    expect(m.buy.maker).toBe(b.maker);
    expect(m.sell.maker).toBe(s.maker);
    expect(m.shares).toBe(100n);
    expect(m.cost).toBe(60n); // executed at the resting seller's ask
  });

  it("does not match when prices do not cross", () => {
    book.submit(sell({ takerAmount: 60n })); // ask 0.6
    const matches = book.submit(buy({ makerAmount: 50n })); // bid 0.5
    expect(matches).toHaveLength(0);
    expect(book.resting(MARKET, 0, SIDE_BUY)).toHaveLength(1);
    expect(book.resting(MARKET, 0, SIDE_SELL)).toHaveLength(1);
  });

  it("does not match orders with different share sizes", () => {
    book.submit(sell({ makerAmount: 100n }));
    const matches = book.submit(buy({ takerAmount: 50n, makerAmount: 40n }));
    expect(matches).toHaveLength(0);
  });

  it("respects price-time priority among equal-price resting orders", () => {
    const s1 = sell();
    const s2 = sell();
    book.submit(s1);
    book.submit(s2);
    const matches = book.submit(buy());
    expect(matches).toHaveLength(1);
    expect(matches[0]!.sell.maker).toBe(s1.maker); // earliest first
  });

  it("cancels a resting order", () => {
    const s = sell();
    book.submit(s);
    expect(book.cancel(`${s.maker}:${s.salt}`)).toBe(true);
    expect(book.resting(MARKET, 0, SIDE_SELL)).toHaveLength(0);
  });
});
