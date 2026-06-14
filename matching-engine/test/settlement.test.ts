import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Ed25519Program, Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import {
  ORDER_SERIALIZED_LEN,
  Order,
  SIDE_BUY,
  SIDE_SELL,
  serializeOrder,
} from "../src/order.js";
import { Match } from "../src/orderbook.js";
import {
  anchorDiscriminator,
  buildSettlementInstructions,
  deriveFill,
  encodeMatchOrdersData,
} from "../src/settlement.js";

const PROGRAM = Keypair.generate().publicKey;
const MARKET = Keypair.generate().publicKey.toBase58();

function order(side: number, over: Partial<Order> = {}): Order {
  return {
    salt: 7n,
    maker: Keypair.generate().publicKey.toBase58(),
    market: MARKET,
    outcome: 0,
    side,
    makerAmount: side === SIDE_BUY ? 70n : 100n,
    takerAmount: side === SIDE_BUY ? 100n : 60n,
    expiration: 0n,
    feeRateBps: 0,
    ...over,
  };
}

describe("settlement encoding", () => {
  it("uses Anchor's sha256(global:match_orders)[..8] discriminator", () => {
    const expected = createHash("sha256")
      .update("global:match_orders")
      .digest()
      .subarray(0, 8);
    expect(anchorDiscriminator("match_orders").equals(expected)).toBe(true);
  });

  it("encodes match_orders data as discriminator + 2 orders + 2 indices", () => {
    const data = encodeMatchOrdersData(order(SIDE_BUY), order(SIDE_SELL), 0, 1);
    // 8 + 100 + 100 + 1 + 1
    expect(data.length).toBe(8 + ORDER_SERIALIZED_LEN * 2 + 2);
    expect(data.subarray(0, 8).equals(anchorDiscriminator("match_orders"))).toBe(
      true,
    );
    expect(data.readUInt8(data.length - 2)).toBe(0);
    expect(data.readUInt8(data.length - 1)).toBe(1);
  });

  it("derives fill PDAs deterministically per (maker, salt)", () => {
    const maker = Keypair.generate().publicKey;
    const a = deriveFill(PROGRAM, maker, 7n);
    const b = deriveFill(PROGRAM, maker, 7n);
    const c = deriveFill(PROGRAM, maker, 8n);
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
  });

  it("builds [ed25519, ed25519, match_orders] with real signatures", () => {
    const buyerKp = Keypair.generate();
    const sellerKp = Keypair.generate();
    const buy = order(SIDE_BUY, { maker: buyerKp.publicKey.toBase58() });
    const sell = order(SIDE_SELL, { maker: sellerKp.publicKey.toBase58() });

    const buySig = nacl.sign.detached(serializeOrder(buy), buyerKp.secretKey);
    const sellSig = nacl.sign.detached(serializeOrder(sell), sellerKp.secretKey);

    const match: Match = { buy, sell, shares: 100n, cost: 60n };
    const ixs = buildSettlementInstructions(
      {
        exchangeProgramId: PROGRAM,
        collateralMint: Keypair.generate().publicKey,
        outcomeMint: Keypair.generate().publicKey,
        operator: Keypair.generate().publicKey,
        feeAuthority: Keypair.generate().publicKey,
      },
      match,
      buySig,
      sellSig,
    );

    expect(ixs).toHaveLength(3);
    expect(ixs[0]!.programId.equals(Ed25519Program.programId)).toBe(true);
    expect(ixs[1]!.programId.equals(Ed25519Program.programId)).toBe(true);
    expect(ixs[2]!.programId.equals(PROGRAM)).toBe(true);
    // match_orders has 14 accounts.
    expect(ixs[2]!.keys).toHaveLength(14);
    // signatures verify against the serialized orders.
    expect(
      nacl.sign.detached.verify(
        serializeOrder(buy),
        buySig,
        buyerKp.publicKey.toBytes(),
      ),
    ).toBe(true);
  });
});
