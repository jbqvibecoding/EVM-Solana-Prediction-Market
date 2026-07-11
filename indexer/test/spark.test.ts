import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { handleRequest } from "../src/api.js";
import { DecodedEvent, decodeEvent, eventDiscriminator } from "../src/events.js";
import { applyEvents, emptyModel } from "../src/projection.js";
import { sparkMarketListings } from "../src/queries.js";
import { PgStore } from "../src/pgStore.js";
import { SqlExecutor } from "../src/sql.js";

const CREATOR = Keypair.generate().publicKey;
const USDC = Keypair.generate().publicKey;
const VAULT = Keypair.generate().publicKey;
const MINT_YES = Keypair.generate().publicKey;
const MINT_NO = Keypair.generate().publicKey;
const USER = Keypair.generate().publicKey;

function u64(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}
function u8(v: number): Buffer {
  return Buffer.from([v]);
}
function pk(v: PublicKey): Buffer {
  return Buffer.from(v.toBytes());
}
function str(v: string): Buffer {
  const utf8 = Buffer.from(v, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(utf8.length);
  return Buffer.concat([len, utf8]);
}
function event(name: string, ...fields: Buffer[]): Buffer {
  return Buffer.concat([eventDiscriminator(name), ...fields]);
}

const CREATED = event(
  "SparkMarketCreated",
  u64(42n), pk(CREATOR), pk(USDC), pk(VAULT), str("BTC $150K?"),
  u64(1n), u64(1_000_000_000_000n), u64(2n), u64(1n),
);
const OUTCOME_YES = event("SparkOutcomeAdded", u64(42n), u8(0), pk(MINT_YES), str("Yes"));
const OUTCOME_NO = event("SparkOutcomeAdded", u64(42n), u8(1), pk(MINT_NO), str("No"));
// 100 USDC in, 2 fee, 500 tokens out (net into curve = 98)
const MINTED = event("SparkTokensMinted", u64(42n), pk(USER), u8(0), u64(100n), u64(2n), u64(500n));
// burn 200 tokens for 30 USDC back
const REDEEMED = event("SparkTokensRedeemed", u64(42n), pk(USER), u8(0), u64(200n), u64(30n));
const RESOLVED = event("SparkMarketResolved", u64(42n), u8(0), u64(68n));
const CLAIMED = event("SparkWinningsClaimed", u64(42n), pk(USER), u64(300n), u64(68n));

function decodeAll(buffers: Buffer[]): DecodedEvent[] {
  return buffers.map((b) => {
    const ev = decodeEvent(b);
    expect(ev).not.toBeNull();
    return ev!;
  });
}

describe("spark event decoding", () => {
  it("decodes SparkMarketCreated with strings and curve params", () => {
    const ev = decodeEvent(CREATED);
    expect(ev).toEqual({
      type: "SparkMarketCreated",
      marketId: 42n,
      creator: CREATOR.toBase58(),
      collateralMint: USDC.toBase58(),
      vault: VAULT.toBase58(),
      title: "BTC $150K?",
      mNum: 1n,
      mDen: 1_000_000_000_000n,
      nNum: 2n,
      nDen: 1n,
    });
  });

  it("decodes mint/redeem/resolve/claim payloads", () => {
    expect(decodeEvent(MINTED)).toMatchObject({
      type: "SparkTokensMinted",
      marketId: 42n,
      outcomeIndex: 0,
      usdcAmount: 100n,
      fee: 2n,
      tokensMinted: 500n,
    });
    expect(decodeEvent(REDEEMED)).toMatchObject({
      type: "SparkTokensRedeemed",
      tokensBurned: 200n,
      usdcReturned: 30n,
    });
    expect(decodeEvent(RESOLVED)).toMatchObject({
      type: "SparkMarketResolved",
      winningOutcome: 0,
      totalPool: 68n,
    });
    expect(decodeEvent(CLAIMED)).toMatchObject({
      type: "SparkWinningsClaimed",
      tokensBurned: 300n,
      payout: 68n,
    });
  });
});

describe("spark projection", () => {
  it("rebuilds market state from the event sequence", () => {
    const model = emptyModel();
    applyEvents(model, decodeAll([CREATED, OUTCOME_YES, OUTCOME_NO, MINTED, REDEEMED]));

    const market = model.sparkMarkets.get("42")!;
    expect(market.title).toBe("BTC $150K?");
    expect(market.status).toBe("active");
    // mint: +98 net (100 − 2 fee); redeem: −30
    expect(market.totalUsdcInCurves).toBe(68n);
    expect(market.totalFeesCollected).toBe(2n);
    const yes = market.outcomes.get(0)!;
    expect(yes.label).toBe("Yes");
    expect(yes.currentSupply).toBe(300n); // 500 minted − 200 burned
    expect(yes.usdcInCurve).toBe(68n);
    expect(market.outcomes.get(1)!.currentSupply).toBe(0n);
  });

  it("resolve + claim update status and winning supply", () => {
    const model = emptyModel();
    applyEvents(model, decodeAll([CREATED, OUTCOME_YES, OUTCOME_NO, MINTED, REDEEMED, RESOLVED, CLAIMED]));

    const market = model.sparkMarkets.get("42")!;
    expect(market.status).toBe("resolved");
    expect(market.winningOutcome).toBe(0);
    expect(market.outcomes.get(0)!.currentSupply).toBe(0n); // 300 − 300 claimed
  });
});

describe("spark listing API", () => {
  it("GET /spark-markets returns the frontend SparkMarketListing shape", () => {
    const model = emptyModel();
    applyEvents(model, decodeAll([CREATED, OUTCOME_YES, OUTCOME_NO, MINTED]));

    const res = handleRequest(model, { method: "GET", path: "/spark-markets", query: {} });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(sparkMarketListings(model));
    expect(res.body).toEqual([
      {
        title: "BTC $150K?",
        config: {
          marketId: "42",
          outcomeCount: 2,
          curve: { mNum: "1", mDen: "1000000000000", nNum: "2", nDen: "1" },
          vault: VAULT.toBase58(),
          totalUsdcDeposited: "98",
          totalFeesCollected: "2",
          status: "active",
          winningOutcome: null,
          outcomes: [
            { index: 0, label: "Yes", mint: MINT_YES.toBase58(), currentSupply: "500", usdcInCurve: "98" },
            { index: 1, label: "No", mint: MINT_NO.toBase58(), currentSupply: "0", usdcInCurve: "0" },
          ],
        },
      },
    ]);
  });
});

describe("spark pgStore upserts", () => {
  it("mint applies outcome and market updates with net + fee params", async () => {
    const calls: { text: string; params: unknown[] }[] = [];
    const fake: SqlExecutor = {
      query: async (text: string, params?: unknown[]) => {
        calls.push({ text, params: params ?? [] });
        return [];
      },
    };
    const store = new PgStore(fake);
    await store.applyEvent(decodeEvent(MINTED)!);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.text).toContain("UPDATE spark_outcomes");
    expect(calls[0]!.params).toEqual(["42", 0, "500", "98"]);
    expect(calls[1]!.text).toContain("UPDATE spark_markets");
    expect(calls[1]!.params).toEqual(["42", "98", "2"]);
  });
});
