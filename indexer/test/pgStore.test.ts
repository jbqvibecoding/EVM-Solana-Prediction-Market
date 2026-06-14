import { describe, expect, it } from "vitest";
import { SqlExecutor } from "../src/sql.js";
import { PgStore } from "../src/pgStore.js";

class FakeExecutor implements SqlExecutor {
  calls: { text: string; params: unknown[] }[] = [];
  private responses: { key: string; rows: unknown[] }[] = [];

  on(key: string, rows: unknown[]): this {
    this.responses.push({ key, rows });
    return this;
  }

  async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
    this.calls.push({ text, params });
    for (const r of this.responses) if (text.includes(r.key)) return r.rows as T[];
    return [] as T[];
  }

  find(substr: string): { text: string; params: unknown[] }[] {
    return this.calls.filter((c) => c.text.includes(substr));
  }
}

describe("PgStore.applyEvent SQL", () => {
  it("OrdersMatched: inserts a trade and upserts both positions", async () => {
    const sql = new FakeExecutor();
    await new PgStore(sql).applyEvent(
      { type: "OrdersMatched", market: "M", outcome: 0, buyer: "B", seller: "S", shares: 100n, cost: 60n, fee: 1n },
      { signature: "sig", slot: 5 },
    );

    expect(sql.find("INTO trades")[0]!.params).toEqual([
      "sig", 5, "M", 0, "B", "S", "100", "60", "1",
    ]);
    const positions = sql.find("INTO positions");
    expect(positions[0]!.params).toEqual(["B", "M", 0, "100"]); // buyer +shares
    expect(positions[1]!.params).toEqual(["S", "M", 0, "-100"]); // seller -shares
  });

  it("ConditionInitialized upserts the condition->market binding with mints", async () => {
    const sql = new FakeExecutor();
    await new PgStore(sql).applyEvent({
      type: "ConditionInitialized", condition: "C", market: "M", collateralMint: "USDC", yesMint: "Y", noMint: "N",
    });
    expect(sql.find("INTO conditions")[0]!.params).toEqual(["C", "M", "USDC", "Y", "N"]);
  });

  it("ConditionResolved records the winning outcome via the condition", async () => {
    const sql = new FakeExecutor();
    await new PgStore(sql).applyEvent({ type: "ConditionResolved", condition: "C", winningOutcome: 1 });
    expect(sql.find("INTO market_resolutions")[0]!.params).toEqual(["C", 1]);
  });

  it("SetSplit adds both outcomes; SetMerged subtracts both", async () => {
    const split = new FakeExecutor();
    await new PgStore(split).applyEvent({ type: "SetSplit", condition: "C", user: "U", amount: 10n });
    expect(split.find("FROM conditions WHERE condition").map((c) => c.params)).toEqual([
      ["U", "C", 0, "10"],
      ["U", "C", 1, "10"],
    ]);

    const merge = new FakeExecutor();
    await new PgStore(merge).applyEvent({ type: "SetMerged", condition: "C", user: "U", amount: 10n });
    expect(merge.find("FROM conditions WHERE condition").map((c) => c.params)).toEqual([
      ["U", "C", 0, "-10"],
      ["U", "C", 1, "-10"],
    ]);
  });

  it("Redeemed burns the winning-outcome shares", async () => {
    const sql = new FakeExecutor();
    await new PgStore(sql).applyEvent({ type: "Redeemed", condition: "C", user: "U", amount: 7n });
    expect(sql.find("market_resolutions r")[0]!.params).toEqual(["U", "C", "-7"]);
  });
});

describe("PgStore reads", () => {
  it("maps positions/volume/leaderboard string columns to bigint", async () => {
    const sql = new FakeExecutor()
      .on("FROM positions WHERE", [{ market: "M", outcome: "0", shares: "150" }])
      .on("SUM(cost)", [{ volume: "60" }])
      .on("GROUP BY trader", [{ trader: "B", volume: "60" }]);
    const store = new PgStore(sql);

    expect(await store.getPositions("B")).toEqual([{ market: "M", outcome: 0, shares: 150n }]);
    expect(await store.getVolume("M")).toBe(60n);
    expect(await store.getLeaderboard()).toEqual([{ trader: "B", volume: 60n }]);
  });

  it("defaults volume to 0 and parses trade rows", async () => {
    const empty = new PgStore(new FakeExecutor());
    expect(await empty.getVolume("X")).toBe(0n);

    const sql = new FakeExecutor().on("ORDER BY slot", [
      { signature: "s", slot: "9", market: "M", outcome: "1", buyer: "B", seller: "S", shares: "100", cost: "60", fee: "1" },
    ]);
    expect(await new PgStore(sql).getTrades("M")).toEqual([
      { signature: "s", slot: 9, market: "M", outcome: 1, buyer: "B", seller: "S", shares: 100n, cost: 60n, fee: 1n },
    ]);
  });

  it("reads and writes the ingest cursor", async () => {
    const sql = new FakeExecutor().on("FROM ingest_cursor", [{ last: "sig9" }]);
    const store = new PgStore(sql);
    expect(await store.getCursor()).toBe("sig9");

    await store.setCursor("sigX");
    expect(sql.find("INTO ingest_cursor")[0]!.params).toEqual(["sigX"]);

    expect(await new PgStore(new FakeExecutor()).getCursor()).toBeNull();
  });
});
