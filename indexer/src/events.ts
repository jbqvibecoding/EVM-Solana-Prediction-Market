import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";

/**
 * Anchor event discriminator: the first 8 bytes of sha256("event:<Name>").
 * `emit!` logs `Program data: base64(discriminator ++ borsh(event))`.
 */
export function eventDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
}

/** Minimal sequential borsh reader for the field types our events use. */
class Reader {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}

  u8(): number {
    const v = this.buf.readUInt8(this.offset);
    this.offset += 1;
    return v;
  }
  u16(): number {
    const v = this.buf.readUInt16LE(this.offset);
    this.offset += 2;
    return v;
  }
  u64(): bigint {
    const v = this.buf.readBigUInt64LE(this.offset);
    this.offset += 8;
    return v;
  }
  i64(): bigint {
    const v = this.buf.readBigInt64LE(this.offset);
    this.offset += 8;
    return v;
  }
  pubkey(): string {
    const v = new PublicKey(this.buf.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return v.toBase58();
  }
  /** Borsh string: u32-LE length prefix + utf8 bytes. */
  string(): string {
    const len = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    const v = this.buf.subarray(this.offset, this.offset + len).toString("utf8");
    this.offset += len;
    return v;
  }
}

export type DecodedEvent =
  | {
      type: "OrdersMatched";
      market: string;
      outcome: number;
      buyer: string;
      seller: string;
      shares: bigint;
      cost: bigint;
      fee: bigint;
    }
  | {
      type: "ConditionInitialized";
      condition: string;
      market: string;
      collateralMint: string;
      yesMint: string;
      noMint: string;
    }
  | { type: "ConditionResolved"; condition: string; winningOutcome: number }
  | { type: "SetSplit"; condition: string; user: string; amount: bigint }
  | { type: "SetMerged"; condition: string; user: string; amount: bigint }
  | { type: "Redeemed"; condition: string; user: string; amount: bigint }
  // events_futures (spark markets) — field order mirrors the Rust event structs.
  | {
      type: "SparkMarketCreated";
      marketId: bigint;
      creator: string;
      collateralMint: string;
      vault: string;
      title: string;
      mNum: bigint;
      mDen: bigint;
      nNum: bigint;
      nDen: bigint;
    }
  | {
      type: "SparkOutcomeAdded";
      marketId: bigint;
      outcomeIndex: number;
      mint: string;
      label: string;
    }
  | {
      type: "SparkTokensMinted";
      marketId: bigint;
      user: string;
      outcomeIndex: number;
      usdcAmount: bigint;
      fee: bigint;
      tokensMinted: bigint;
    }
  | {
      type: "SparkTokensRedeemed";
      marketId: bigint;
      user: string;
      outcomeIndex: number;
      tokensBurned: bigint;
      usdcReturned: bigint;
    }
  | { type: "SparkMarketResolved"; marketId: bigint; winningOutcome: number; totalPool: bigint }
  | { type: "SparkWinningsClaimed"; marketId: bigint; user: string; tokensBurned: bigint; payout: bigint }
  | { type: "SparkFeesCollected"; marketId: bigint; amount: bigint };

type EventName = DecodedEvent["type"];

const EVENT_NAMES: EventName[] = [
  "OrdersMatched",
  "ConditionInitialized",
  "ConditionResolved",
  "SetSplit",
  "SetMerged",
  "Redeemed",
  "SparkMarketCreated",
  "SparkOutcomeAdded",
  "SparkTokensMinted",
  "SparkTokensRedeemed",
  "SparkMarketResolved",
  "SparkWinningsClaimed",
  "SparkFeesCollected",
];

// name -> discriminator hex, for fast lookup.
const DISCRIMINATOR_TO_NAME = new Map<string, EventName>(
  EVENT_NAMES.map((n) => [eventDiscriminator(n).toString("hex"), n]),
);

function decodeBody(name: EventName, r: Reader): DecodedEvent {
  switch (name) {
    case "OrdersMatched":
      return {
        type: "OrdersMatched",
        market: r.pubkey(),
        outcome: r.u8(),
        buyer: r.pubkey(),
        seller: r.pubkey(),
        shares: r.u64(),
        cost: r.u64(),
        fee: r.u64(),
      };
    case "ConditionInitialized":
      return {
        type: "ConditionInitialized",
        condition: r.pubkey(),
        market: r.pubkey(),
        collateralMint: r.pubkey(),
        yesMint: r.pubkey(),
        noMint: r.pubkey(),
      };
    case "ConditionResolved":
      return {
        type: "ConditionResolved",
        condition: r.pubkey(),
        winningOutcome: r.u8(),
      };
    case "SetSplit":
      return { type: "SetSplit", condition: r.pubkey(), user: r.pubkey(), amount: r.u64() };
    case "SetMerged":
      return { type: "SetMerged", condition: r.pubkey(), user: r.pubkey(), amount: r.u64() };
    case "Redeemed":
      return { type: "Redeemed", condition: r.pubkey(), user: r.pubkey(), amount: r.u64() };
    case "SparkMarketCreated":
      return {
        type: "SparkMarketCreated",
        marketId: r.u64(),
        creator: r.pubkey(),
        collateralMint: r.pubkey(),
        vault: r.pubkey(),
        title: r.string(),
        mNum: r.u64(),
        mDen: r.u64(),
        nNum: r.u64(),
        nDen: r.u64(),
      };
    case "SparkOutcomeAdded":
      return {
        type: "SparkOutcomeAdded",
        marketId: r.u64(),
        outcomeIndex: r.u8(),
        mint: r.pubkey(),
        label: r.string(),
      };
    case "SparkTokensMinted":
      return {
        type: "SparkTokensMinted",
        marketId: r.u64(),
        user: r.pubkey(),
        outcomeIndex: r.u8(),
        usdcAmount: r.u64(),
        fee: r.u64(),
        tokensMinted: r.u64(),
      };
    case "SparkTokensRedeemed":
      return {
        type: "SparkTokensRedeemed",
        marketId: r.u64(),
        user: r.pubkey(),
        outcomeIndex: r.u8(),
        tokensBurned: r.u64(),
        usdcReturned: r.u64(),
      };
    case "SparkMarketResolved":
      return {
        type: "SparkMarketResolved",
        marketId: r.u64(),
        winningOutcome: r.u8(),
        totalPool: r.u64(),
      };
    case "SparkWinningsClaimed":
      return {
        type: "SparkWinningsClaimed",
        marketId: r.u64(),
        user: r.pubkey(),
        tokensBurned: r.u64(),
        payout: r.u64(),
      };
    case "SparkFeesCollected":
      return { type: "SparkFeesCollected", marketId: r.u64(), amount: r.u64() };
  }
}

/** Decode one `Program data` event payload (discriminator + borsh). */
export function decodeEvent(data: Buffer): DecodedEvent | null {
  if (data.length < 8) return null;
  const name = DISCRIMINATOR_TO_NAME.get(data.subarray(0, 8).toString("hex"));
  if (!name) return null;
  try {
    return decodeBody(name, new Reader(data.subarray(8)));
  } catch {
    return null;
  }
}

/** Extract and decode all known events from a transaction's log messages. */
export function decodeProgramDataLogs(logs: string[]): DecodedEvent[] {
  const out: DecodedEvent[] = [];
  for (const line of logs) {
    const marker = "Program data: ";
    if (!line.startsWith(marker)) continue;
    const b64 = line.slice(marker.length).trim();
    let buf: Buffer;
    try {
      buf = Buffer.from(b64, "base64");
    } catch {
      continue;
    }
    const ev = decodeEvent(buf);
    if (ev) out.push(ev);
  }
  return out;
}
