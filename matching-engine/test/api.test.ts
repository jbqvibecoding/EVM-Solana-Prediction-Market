import { beforeEach, describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { handleRequest, toWireOrder } from "../src/api.js";
import { MatchingEngine, Settler } from "../src/engine.js";
import { Match, OrderBook } from "../src/orderbook.js";
import { Order, SIDE_BUY, SIDE_SELL, orderId, serializeOrder } from "../src/order.js";

const MARKET = Keypair.generate().publicKey.toBase58();

class MockSettler implements Settler {
  async settle(_m: Match): Promise<string> {
    return "tx";
  }
}

function signedBody(side: number, over: Partial<Order> = {}) {
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
  const signature = Buffer.from(
    nacl.sign.detached(serializeOrder(order), kp.secretKey),
  ).toString("base64");
  return { order, body: { order: toWireOrder(order), signature } };
}

describe("api router", () => {
  let engine: MatchingEngine;
  beforeEach(() => {
    engine = new MatchingEngine(new OrderBook(), new MockSettler());
  });

  it("health check", async () => {
    const res = await handleRequest(engine, {
      method: "GET",
      path: "/health",
      query: {},
      body: undefined,
    });
    expect(res.status).toBe(200);
  });

  it("accepts an order and reports a resting book", async () => {
    const sell = signedBody(SIDE_SELL);
    const post = await handleRequest(engine, {
      method: "POST",
      path: "/order",
      query: {},
      body: sell.body,
    });
    expect(post.status).toBe(200);
    expect((post.body as { matches: unknown[] }).matches).toHaveLength(0);

    const ob = await handleRequest(engine, {
      method: "GET",
      path: "/orderbook",
      query: { market: MARKET, outcome: "0" },
      body: undefined,
    });
    expect(ob.status).toBe(200);
    expect((ob.body as { asks: unknown[] }).asks).toHaveLength(1);
  });

  it("matches a crossing order and returns settlement tx", async () => {
    await handleRequest(engine, {
      method: "POST",
      path: "/order",
      query: {},
      body: signedBody(SIDE_SELL).body,
    });
    const post = await handleRequest(engine, {
      method: "POST",
      path: "/order",
      query: {},
      body: signedBody(SIDE_BUY).body,
    });
    expect(post.status).toBe(200);
    const b = post.body as { matches: unknown[]; settlements: string[] };
    expect(b.matches).toHaveLength(1);
    expect(b.settlements).toEqual(["tx"]);
  });

  it("rejects an order with a bad signature", async () => {
    const { body } = signedBody(SIDE_BUY);
    body.signature = Buffer.from(new Uint8Array(64)).toString("base64");
    const res = await handleRequest(engine, {
      method: "POST",
      path: "/order",
      query: {},
      body,
    });
    expect(res.status).toBe(400);
  });

  it("cancels a resting order via /order/:id/cancel", async () => {
    const sell = signedBody(SIDE_SELL);
    await handleRequest(engine, {
      method: "POST",
      path: "/order",
      query: {},
      body: sell.body,
    });
    const id = orderId(sell.order);
    const res = await handleRequest(engine, {
      method: "POST",
      path: `/order/${encodeURIComponent(id)}/cancel`,
      query: {},
      body: undefined,
    });
    expect(res.status).toBe(200);
    expect((res.body as { cancelled: boolean }).cancelled).toBe(true);
  });
});
