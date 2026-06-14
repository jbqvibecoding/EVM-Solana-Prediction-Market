import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { eventDiscriminator } from "../src/events.js";
import { Cursor, LogSource, TxLogs, ingestOnce } from "../src/ingest.js";
import { emptyModel, getPosition, OUTCOME_YES } from "../src/projection.js";

function u64(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}

function ordersMatchedLog(
  market: string,
  buyer: string,
  seller: string,
): string {
  const data = Buffer.concat([
    eventDiscriminator("OrdersMatched"),
    new PublicKey(market).toBuffer(),
    Buffer.from([OUTCOME_YES]),
    new PublicKey(buyer).toBuffer(),
    new PublicKey(seller).toBuffer(),
    u64(100n),
    u64(60n),
    u64(0n),
  ]);
  return `Program data: ${data.toString("base64")}`;
}

class MockSource implements LogSource {
  constructor(private readonly batches: TxLogs[][]) {}
  async fetchSince(_cursor: string | null): Promise<TxLogs[]> {
    return this.batches.shift() ?? [];
  }
}

describe("ingestOnce", () => {
  it("projects events from fetched txs and advances the cursor", async () => {
    const market = Keypair.generate().publicKey.toBase58();
    const buyer = Keypair.generate().publicKey.toBase58();
    const seller = Keypair.generate().publicKey.toBase58();

    const source = new MockSource([
      [{ signature: "sigA", slot: 1, logs: [ordersMatchedLog(market, buyer, seller)] }],
    ]);
    const model = emptyModel();
    const cursor: Cursor = { last: null };

    const n = await ingestOnce(source, model, cursor);
    expect(n).toBe(1);
    expect(cursor.last).toBe("sigA");
    expect(getPosition(model, buyer, market, OUTCOME_YES)).toBe(100n);
    expect(getPosition(model, seller, market, OUTCOME_YES)).toBe(-100n);
    expect(model.trades[0]!.signature).toBe("sigA");
  });

  it("returns 0 and leaves the cursor when there is nothing new", async () => {
    const source = new MockSource([]);
    const model = emptyModel();
    const cursor: Cursor = { last: "prev" };
    const n = await ingestOnce(source, model, cursor);
    expect(n).toBe(0);
    expect(cursor.last).toBe("prev");
  });
});
