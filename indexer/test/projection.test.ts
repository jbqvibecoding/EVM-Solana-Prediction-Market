import { beforeEach, describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { DecodedEvent } from "../src/events.js";
import {
  OUTCOME_NO,
  OUTCOME_YES,
  ReadModel,
  applyEvent,
  emptyModel,
  getPosition,
  getVolume,
} from "../src/projection.js";

const pk = () => Keypair.generate().publicKey.toBase58();

describe("projection", () => {
  let model: ReadModel;
  const market = pk();
  const condition = pk();

  beforeEach(() => {
    model = emptyModel();
    const init: DecodedEvent = {
      type: "ConditionInitialized",
      condition,
      market,
      collateralMint: pk(),
      yesMint: pk(),
      noMint: pk(),
    };
    applyEvent(model, init);
  });

  it("splits credit equal YES and NO shares", () => {
    const user = pk();
    applyEvent(model, { type: "SetSplit", condition, user, amount: 500n });
    expect(getPosition(model, user, market, OUTCOME_YES)).toBe(500n);
    expect(getPosition(model, user, market, OUTCOME_NO)).toBe(500n);
  });

  it("merges debit equal YES and NO shares", () => {
    const user = pk();
    applyEvent(model, { type: "SetSplit", condition, user, amount: 500n });
    applyEvent(model, { type: "SetMerged", condition, user, amount: 200n });
    expect(getPosition(model, user, market, OUTCOME_YES)).toBe(300n);
    expect(getPosition(model, user, market, OUTCOME_NO)).toBe(300n);
  });

  it("records trades, volume and position transfer on a match", () => {
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
      { signature: "sig1", slot: 42 },
    );
    expect(model.trades).toHaveLength(1);
    expect(model.trades[0]!.signature).toBe("sig1");
    expect(getVolume(model, market)).toBe(60n);
    expect(getPosition(model, buyer, market, OUTCOME_YES)).toBe(100n);
    expect(getPosition(model, seller, market, OUTCOME_YES)).toBe(-100n);
  });

  it("redeem reduces the winning position after resolution", () => {
    const user = pk();
    applyEvent(model, { type: "SetSplit", condition, user, amount: 500n });
    applyEvent(model, { type: "ConditionResolved", condition, winningOutcome: OUTCOME_YES });
    applyEvent(model, { type: "Redeemed", condition, user, amount: 300n });
    expect(model.marketResolved.get(market)).toBe(OUTCOME_YES);
    expect(getPosition(model, user, market, OUTCOME_YES)).toBe(200n);
    // NO position untouched by redeem
    expect(getPosition(model, user, market, OUTCOME_NO)).toBe(500n);
  });

  it("ignores split for an unknown condition", () => {
    const user = pk();
    applyEvent(model, { type: "SetSplit", condition: pk(), user, amount: 10n });
    expect(getPosition(model, user, market, OUTCOME_YES)).toBe(0n);
  });
});
