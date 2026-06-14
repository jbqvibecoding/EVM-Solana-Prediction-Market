import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { handleRequest } from "../src/api.js";
import { OUTCOME_YES, applyEvent, emptyModel, ReadModel } from "../src/projection.js";

const pk = () => Keypair.generate().publicKey.toBase58();

function seeded(): { model: ReadModel; market: string; buyer: string; seller: string } {
  const model = emptyModel();
  const market = pk();
  const buyer = pk();
  const seller = pk();
  applyEvent(
    model,
    {
      type: "OrdersMatched",
      market,
      outcome: OUTCOME_YES,
      buyer,
      seller,
      shares: 100n,
      cost: 60n,
      fee: 1n,
    },
    { signature: "sig", slot: 1 },
  );
  return { model, market, buyer, seller };
}

describe("indexer api", () => {
  it("returns a user's positions", () => {
    const { model, market, buyer } = seeded();
    const res = handleRequest(model, {
      method: "GET",
      path: "/positions",
      query: { user: buyer },
    });
    expect(res.status).toBe(200);
    const body = res.body as Array<{ market: string; outcome: number; shares: string }>;
    expect(body).toContainEqual({ market, outcome: OUTCOME_YES, shares: "100" });
  });

  it("returns market volume", () => {
    const { model, market } = seeded();
    const res = handleRequest(model, {
      method: "GET",
      path: "/volume",
      query: { market },
    });
    expect(res.body).toEqual({ market, volume: "60" });
  });

  it("returns trades and leaderboard", () => {
    const { model, buyer } = seeded();
    const trades = handleRequest(model, { method: "GET", path: "/trades", query: {} });
    expect((trades.body as unknown[]).length).toBe(1);

    const lb = handleRequest(model, { method: "GET", path: "/leaderboard", query: {} });
    const board = lb.body as Array<{ trader: string; volume: string }>;
    expect(board.find((e) => e.trader === buyer)?.volume).toBe("60");
  });

  it("400s without required params and 404s unknown routes", () => {
    const { model } = seeded();
    expect(handleRequest(model, { method: "GET", path: "/positions", query: {} }).status).toBe(400);
    expect(handleRequest(model, { method: "GET", path: "/nope", query: {} }).status).toBe(404);
  });
});
