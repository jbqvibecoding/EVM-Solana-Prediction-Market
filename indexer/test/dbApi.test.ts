import { describe, expect, it } from "vitest";
import { handleDbRequest } from "../src/dbApi.js";
import { Store, StorePosition, StoreTrade, TraderVolume } from "../src/store.js";

function fakeStore(overrides: Partial<Store> = {}): Store {
  return {
    applyEvent: async () => {},
    getPositions: async () => [],
    getVolume: async () => 0n,
    getTrades: async () => [],
    getLeaderboard: async () => [],
    getCursor: async () => null,
    setCursor: async () => {},
    ...overrides,
  };
}

const req = (path: string, query: Record<string, string | undefined> = {}) => ({
  method: "GET",
  path,
  query,
});

describe("handleDbRequest", () => {
  it("health", async () => {
    expect(await handleDbRequest(fakeStore(), req("/health"))).toEqual({ status: 200, body: { ok: true } });
  });

  it("positions requires user and serializes bigint shares", async () => {
    const positions: StorePosition[] = [{ market: "M", outcome: 0, shares: 150n }];
    const store = fakeStore({ getPositions: async (u) => (u === "B" ? positions : []) });
    expect(await handleDbRequest(store, req("/positions"))).toEqual({
      status: 400, body: { error: "user required" },
    });
    expect(await handleDbRequest(store, req("/positions", { user: "B" }))).toEqual({
      status: 200, body: [{ market: "M", outcome: 0, shares: "150" }],
    });
  });

  it("volume requires market", async () => {
    const store = fakeStore({ getVolume: async () => 60n });
    expect(await handleDbRequest(store, req("/volume"))).toEqual({
      status: 400, body: { error: "market required" },
    });
    expect(await handleDbRequest(store, req("/volume", { market: "M" }))).toEqual({
      status: 200, body: { market: "M", volume: "60" },
    });
  });

  it("trades serialize and leaderboard maps", async () => {
    const trades: StoreTrade[] = [
      { signature: "s", slot: 9, market: "M", outcome: 1, buyer: "B", seller: "S", shares: 100n, cost: 60n, fee: 1n },
    ];
    const board: TraderVolume[] = [{ trader: "B", volume: 60n }];
    const store = fakeStore({ getTrades: async () => trades, getLeaderboard: async () => board });

    const t = await handleDbRequest(store, req("/trades", { market: "M" }));
    expect(t.body).toEqual([
      { market: "M", outcome: 1, buyer: "B", seller: "S", shares: "100", cost: "60", fee: "1", signature: "s", slot: 9 },
    ]);
    const l = await handleDbRequest(store, req("/leaderboard"));
    expect(l.body).toEqual([{ trader: "B", volume: "60" }]);
  });

  it("unknown path 404, non-GET 405", async () => {
    expect((await handleDbRequest(fakeStore(), req("/nope"))).status).toBe(404);
    expect((await handleDbRequest(fakeStore(), { method: "POST", path: "/trades", query: {} })).status).toBe(405);
  });
});
