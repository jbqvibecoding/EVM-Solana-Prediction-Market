import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  ORDER_SERIALIZED_LEN,
  Order,
  SIDE_BUY,
  serializeOrder,
} from "../src/order.js";

function sampleOrder(over: Partial<Order> = {}): Order {
  return {
    salt: 42n,
    maker: Keypair.generate().publicKey.toBase58(),
    market: Keypair.generate().publicKey.toBase58(),
    outcome: 0,
    side: SIDE_BUY,
    makerAmount: 70n,
    takerAmount: 100n,
    expiration: 0n,
    feeRateBps: 0,
    ...over,
  };
}

describe("serializeOrder", () => {
  it("produces the fixed 100-byte borsh layout", () => {
    const buf = serializeOrder(sampleOrder());
    expect(buf.length).toBe(ORDER_SERIALIZED_LEN);
  });

  it("places fields at the exact borsh offsets", () => {
    const maker = Keypair.generate().publicKey;
    const market = Keypair.generate().publicKey;
    const order = sampleOrder({
      salt: 0x0102030405060708n,
      maker: maker.toBase58(),
      market: market.toBase58(),
      outcome: 1,
      side: 1,
      makerAmount: 100n,
      takerAmount: 60n,
      expiration: 1700000000n,
      feeRateBps: 250,
    });
    const buf = serializeOrder(order);

    expect(buf.readBigUInt64LE(0)).toBe(0x0102030405060708n);
    expect(new PublicKey(buf.subarray(8, 40)).equals(maker)).toBe(true);
    expect(new PublicKey(buf.subarray(40, 72)).equals(market)).toBe(true);
    expect(buf.readUInt8(72)).toBe(1); // outcome
    expect(buf.readUInt8(73)).toBe(1); // side
    expect(buf.readBigUInt64LE(74)).toBe(100n); // maker_amount
    expect(buf.readBigUInt64LE(82)).toBe(60n); // taker_amount
    expect(buf.readBigInt64LE(90)).toBe(1700000000n); // expiration
    expect(buf.readUInt16LE(98)).toBe(250); // fee_rate_bps
  });
});
