import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { MatchingEngine, Settler, SignedOrder } from "../src/engine.js";
import { Match, OrderBook } from "../src/orderbook.js";
import { Order, SIDE_BUY, SIDE_SELL, serializeOrder } from "../src/order.js";

const MARKET = Keypair.generate().publicKey.toBase58();

function signed(side: number, over: Partial<Order> = {}): SignedOrder {
  const kp = Keypair.generate();
  const order: Order = {
    salt: BigInt(Math.floor(Math.random() * 1e9)),
    maker: kp.publicKey.toBase58(),
    market: MARKET,
    outcome: 0,
    side,
    makerAmount: side === SIDE_BUY ? 70n : 100n,
    takerAmount: side === SIDE_BUY ? 100n : 60n,
    expiration: 0n,
    feeRateBps: 0,
    ...over,
  };
  const signature = nacl.sign.detached(serializeOrder(order), kp.secretKey);
  return { order, signature };
}

class MockSettler implements Settler {
  public calls: Array<{ match: Match }> = [];
  async settle(match: Match): Promise<string> {
    this.calls.push({ match });
    return `tx-${this.calls.length}`;
  }
}

describe("MatchingEngine", () => {
  let book: OrderBook;
  let settler: MockSettler;
  let engine: MatchingEngine;

  beforeEach(() => {
    book = new OrderBook();
    settler = new MockSettler();
    engine = new MatchingEngine(book, settler);
  });

  it("rests an unmatched order without settling", async () => {
    const res = await engine.submit(signed(SIDE_SELL));
    expect(res.matches).toHaveLength(0);
    expect(res.settlements).toHaveLength(0);
    expect(settler.calls).toHaveLength(0);
  });

  it("settles when a taker crosses a resting order", async () => {
    const sell = signed(SIDE_SELL);
    await engine.submit(sell);
    const buy = signed(SIDE_BUY);
    const res = await engine.submit(buy);

    expect(res.matches).toHaveLength(1);
    expect(res.settlements).toEqual(["tx-1"]);
    expect(settler.calls).toHaveLength(1);
    expect(settler.calls[0]!.match.buy.maker).toBe(buy.order.maker);
    expect(settler.calls[0]!.match.sell.maker).toBe(sell.order.maker);
  });

  it("rejects a tampered signature", async () => {
    const s = signed(SIDE_BUY);
    s.signature[0] ^= 0xff; // corrupt
    await expect(engine.submit(s)).rejects.toThrow(/invalid signature/);
  });

  it("rejects a mismatched maker signature", async () => {
    const s = signed(SIDE_BUY);
    const other = Keypair.generate();
    s.signature = nacl.sign.detached(serializeOrder(s.order), other.secretKey);
    await expect(engine.submit(s)).rejects.toThrow(/invalid signature/);
  });

  it("rejects an expired order", async () => {
    const fixedNow = 2_000_000_000;
    engine = new MatchingEngine(book, settler, () => fixedNow);
    const s = signed(SIDE_BUY, { expiration: 1_000_000_000n });
    await expect(engine.submit(s)).rejects.toThrow(/expired/);
  });
});
