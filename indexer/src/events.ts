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
  | { type: "Redeemed"; condition: string; user: string; amount: bigint };

type EventName = DecodedEvent["type"];

const EVENT_NAMES: EventName[] = [
  "OrdersMatched",
  "ConditionInitialized",
  "ConditionResolved",
  "SetSplit",
  "SetMerged",
  "Redeemed",
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
