import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { decodeEvent, decodeProgramDataLogs, eventDiscriminator } from "../src/events.js";

function u64(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}

function pk(): { key: PublicKey; buf: Buffer; b58: string } {
  const key = Keypair.generate().publicKey;
  return { key, buf: key.toBuffer(), b58: key.toBase58() };
}

describe("event decoding", () => {
  it("uses sha256(event:<Name>)[..8] discriminators", () => {
    const expected = createHash("sha256")
      .update("event:OrdersMatched")
      .digest()
      .subarray(0, 8);
    expect(eventDiscriminator("OrdersMatched").equals(expected)).toBe(true);
  });

  it("round-trips an OrdersMatched event", () => {
    const market = pk();
    const buyer = pk();
    const seller = pk();
    const data = Buffer.concat([
      eventDiscriminator("OrdersMatched"),
      market.buf,
      Buffer.from([0]), // outcome YES
      buyer.buf,
      seller.buf,
      u64(100n),
      u64(60n),
      u64(1n),
    ]);

    const ev = decodeEvent(data);
    expect(ev?.type).toBe("OrdersMatched");
    if (ev?.type !== "OrdersMatched") throw new Error("wrong type");
    expect(ev.market).toBe(market.b58);
    expect(ev.outcome).toBe(0);
    expect(ev.buyer).toBe(buyer.b58);
    expect(ev.seller).toBe(seller.b58);
    expect(ev.shares).toBe(100n);
    expect(ev.cost).toBe(60n);
    expect(ev.fee).toBe(1n);
  });

  it("extracts events from Program data log lines and ignores others", () => {
    const condition = pk();
    const user = pk();
    const data = Buffer.concat([
      eventDiscriminator("SetSplit"),
      condition.buf,
      user.buf,
      u64(500n),
    ]);
    const logs = [
      "Program log: ix: split",
      `Program data: ${data.toString("base64")}`,
      "Program consumed 1234 units",
    ];
    const events = decodeProgramDataLogs(logs);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("SetSplit");
  });

  it("returns null for an unknown discriminator", () => {
    expect(decodeEvent(Buffer.alloc(40, 7))).toBeNull();
  });
});
