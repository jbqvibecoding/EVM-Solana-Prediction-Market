import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";
import { Order, SIDE_BUY, SIDE_SELL, orderId, serializeOrder } from "./order.js";
import { Match, OrderBook } from "./orderbook.js";

/** An order plus the maker's ed25519 signature over `serializeOrder(order)`. */
export interface SignedOrder {
  order: Order;
  signature: Uint8Array;
}

/** Settles a matched pair on-chain and returns the transaction signature. */
export interface Settler {
  settle(
    match: Match,
    buySignature: Uint8Array,
    sellSignature: Uint8Array,
  ): Promise<string>;
}

export interface SubmitResult {
  matches: Match[];
  /** transaction signatures for each settled match */
  settlements: string[];
}

/** Verify a maker signed exactly the order bytes the chain will check. */
export function verifyOrderSignature(order: Order, signature: Uint8Array): boolean {
  try {
    return nacl.sign.detached.verify(
      serializeOrder(order),
      signature,
      new PublicKey(order.maker).toBytes(),
    );
  } catch {
    return false;
  }
}

/**
 * Coordinates order validation, the order book, and on-chain settlement.
 *
 * Signatures are retained per resting order so that when a later taker crosses
 * it, both makers' signatures are available to build the settlement transaction.
 */
export class MatchingEngine {
  private readonly signatures = new Map<string, Uint8Array>();

  constructor(
    private readonly book: OrderBook,
    private readonly settler: Settler,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async submit(submission: SignedOrder): Promise<SubmitResult> {
    const { order, signature } = submission;

    if (order.side !== SIDE_BUY && order.side !== SIDE_SELL) {
      throw new Error("invalid side");
    }
    if (order.expiration !== 0n && BigInt(this.now()) > order.expiration) {
      throw new Error("order expired");
    }
    if (!verifyOrderSignature(order, signature)) {
      throw new Error("invalid signature");
    }

    const id = orderId(order);
    this.signatures.set(id, signature);

    let matches: Match[];
    try {
      matches = this.book.submit(order);
    } catch (err) {
      this.signatures.delete(id);
      throw err;
    }

    const settlements: string[] = [];
    for (const match of matches) {
      const buyId = orderId(match.buy);
      const sellId = orderId(match.sell);
      const buySig = this.signatures.get(buyId);
      const sellSig = this.signatures.get(sellId);
      if (!buySig || !sellSig) {
        throw new Error(`missing signature for matched order`);
      }
      const tx = await this.settler.settle(match, buySig, sellSig);
      settlements.push(tx);
      this.signatures.delete(buyId);
      this.signatures.delete(sellId);
    }

    return { matches, settlements };
  }

  cancel(id: string): boolean {
    this.signatures.delete(id);
    return this.book.cancel(id);
  }

  /** Resting bids/asks for a market/outcome. */
  orderBook(market: string, outcome: number): { bids: Order[]; asks: Order[] } {
    return {
      bids: this.book.resting(market, outcome, SIDE_BUY),
      asks: this.book.resting(market, outcome, SIDE_SELL),
    };
  }

  /** Best bid/ask prices for a market/outcome. */
  prices(market: string, outcome: number): { bid: number | null; ask: number | null } {
    return this.book.topOfBook(market, outcome);
  }
}
