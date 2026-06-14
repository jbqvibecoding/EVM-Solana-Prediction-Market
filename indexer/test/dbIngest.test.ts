import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { eventDiscriminator } from "../src/events.js";
import { ingestOnceDb } from "../src/dbIngest.js";
import { LogSource, TxLogs } from "../src/ingest.js";
import { DecodedEvent } from "../src/events.js";
import { EventMeta } from "../src/projection.js";
import { Store } from "../src/store.js";

function u64(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}

function ordersMatchedLog(market: string, buyer: string, seller: string): string {
  const body = Buffer.concat([
    new PublicKey(market).toBuffer(),
    Buffer.from([0]), // outcome YES
    new PublicKey(buyer).toBuffer(),
    new PublicKey(seller).toBuffer(),
    u64(100n),
    u64(60n),
    u64(1n),
  ]);
  const payload = Buffer.concat([eventDiscriminator("OrdersMatched"), body]);
  return `Program data: ${payload.toString("base64")}`;
}

function recordingStore() {
  const applied: { ev: DecodedEvent; meta?: EventMeta }[] = [];
  let cursor: string | null = "start";
  const store: Store = {
    applyEvent: async (ev, meta) => {
      applied.push({ ev, meta });
    },
    getCursor: async () => cursor,
    setCursor: async (s) => {
      cursor = s;
    },
    getPositions: async () => [],
    getVolume: async () => 0n,
    getTrades: async () => [],
    getLeaderboard: async () => [],
  };
  return { store, applied, cursor: () => cursor };
}

function source(txs: TxLogs[], seen: (string | null)[]): LogSource {
  return {
    fetchSince: async (c) => {
      seen.push(c);
      return txs;
    },
  };
}

describe("ingestOnceDb", () => {
  it("decodes events, applies them, and advances the persisted cursor", async () => {
    const market = Keypair.generate().publicKey.toBase58();
    const buyer = Keypair.generate().publicKey.toBase58();
    const seller = Keypair.generate().publicKey.toBase58();
    const { store, applied, cursor } = recordingStore();
    const seen: (string | null)[] = [];

    const tx: TxLogs = { signature: "sigA", slot: 7, logs: [ordersMatchedLog(market, buyer, seller)] };
    const n = await ingestOnceDb(source([tx], seen), store);

    expect(n).toBe(1);
    expect(seen).toEqual(["start"]); // fetched from the stored cursor
    expect(applied).toHaveLength(1);
    expect(applied[0]!.ev).toMatchObject({ type: "OrdersMatched", market, buyer, seller, shares: 100n });
    expect(applied[0]!.meta).toEqual({ signature: "sigA", slot: 7 });
    expect(cursor()).toBe("sigA"); // advanced
  });

  it("advances the cursor even for txs with no decodable events", async () => {
    const { store, applied, cursor } = recordingStore();
    const tx: TxLogs = { signature: "sigB", slot: 8, logs: ["Program log: noise"] };
    const n = await ingestOnceDb(source([tx], []), store);

    expect(n).toBe(1);
    expect(applied).toHaveLength(0);
    expect(cursor()).toBe("sigB");
  });
});
