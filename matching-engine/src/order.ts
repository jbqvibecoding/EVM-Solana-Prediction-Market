import { PublicKey } from "@solana/web3.js";

export const SIDE_BUY = 0;
export const SIDE_SELL = 1;

export const OUTCOME_YES = 0;
export const OUTCOME_NO = 1;

/**
 * Order as signed by the maker. The byte layout produced by {@link serializeOrder}
 * MUST match the borsh layout of `exchange::state::Order` on-chain, since the
 * maker signs these exact bytes and the program re-derives and compares them.
 *
 * Rust field order (borsh, no padding):
 *   salt u64 | maker [u8;32] | market [u8;32] | outcome u8 | side u8 |
 *   maker_amount u64 | taker_amount u64 | expiration i64 | fee_rate_bps u16
 */
export interface Order {
  salt: bigint;
  /** base58 public key */
  maker: string;
  /** base58 public key */
  market: string;
  /** 0 = YES, 1 = NO */
  outcome: number;
  /** 0 = BUY, 1 = SELL */
  side: number;
  /** BUY: collateral given; SELL: shares given */
  makerAmount: bigint;
  /** BUY: shares wanted; SELL: collateral wanted */
  takerAmount: bigint;
  /** unix seconds; 0 = no expiry */
  expiration: bigint;
  feeRateBps: number;
}

export const ORDER_SERIALIZED_LEN = 100;

/** Serialize an order to the exact borsh byte layout the on-chain program expects. */
export function serializeOrder(order: Order): Buffer {
  const buf = Buffer.alloc(ORDER_SERIALIZED_LEN);
  let o = 0;

  buf.writeBigUInt64LE(order.salt, o);
  o += 8;

  new PublicKey(order.maker).toBuffer().copy(buf, o);
  o += 32;

  new PublicKey(order.market).toBuffer().copy(buf, o);
  o += 32;

  buf.writeUInt8(order.outcome, o);
  o += 1;

  buf.writeUInt8(order.side, o);
  o += 1;

  buf.writeBigUInt64LE(order.makerAmount, o);
  o += 8;

  buf.writeBigUInt64LE(order.takerAmount, o);
  o += 8;

  buf.writeBigInt64LE(order.expiration, o);
  o += 8;

  buf.writeUInt16LE(order.feeRateBps, o);
  o += 2;

  if (o !== ORDER_SERIALIZED_LEN) {
    throw new Error(`order serialization length mismatch: ${o}`);
  }
  return buf;
}

/**
 * Price expressed as collateral per share, scaled to a float for ordering only.
 * For BUY: makerAmount (collateral) / takerAmount (shares).
 * For SELL: takerAmount (collateral) / makerAmount (shares).
 * On-chain settlement uses the integer amounts, never this float.
 */
export function orderPrice(order: Order): number {
  if (order.side === SIDE_BUY) {
    return Number(order.makerAmount) / Number(order.takerAmount);
  }
  return Number(order.takerAmount) / Number(order.makerAmount);
}

/** Number of outcome shares the order is for. */
export function orderShares(order: Order): bigint {
  return order.side === SIDE_BUY ? order.takerAmount : order.makerAmount;
}

/** Stable per-order identity used for dedupe and replay tracking: `${maker}:${salt}`. */
export function orderId(order: Order): string {
  return `${order.maker}:${order.salt.toString()}`;
}
