import { createHash } from "node:crypto";
import {
  AccountMeta,
  Ed25519Program,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import { Match } from "./orderbook.js";
import { Order, serializeOrder } from "./order.js";

export const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

const EXCHANGE_SEED = Buffer.from("exchange");
const FILL_SEED = Buffer.from("fill");

/** Anchor's 8-byte instruction discriminator: sha256("global:<name>")[..8]. */
export function anchorDiscriminator(ixName: string): Buffer {
  return createHash("sha256").update(`global:${ixName}`).digest().subarray(0, 8);
}

export function deriveExchange(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([EXCHANGE_SEED], programId)[0];
}

export function deriveFill(
  programId: PublicKey,
  maker: PublicKey,
  salt: bigint,
): PublicKey {
  const saltBuf = Buffer.alloc(8);
  saltBuf.writeBigUInt64LE(salt);
  return PublicKey.findProgramAddressSync(
    [FILL_SEED, maker.toBuffer(), saltBuf],
    programId,
  )[0];
}

/** Associated token account for (owner, mint). */
export function deriveAta(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

/**
 * Build a self-contained Ed25519 verify instruction proving `signer` signed
 * `message`. `instructionIndex` is the position this instruction will occupy in
 * the transaction (the on-chain verifier reads it back at that index).
 */
export function buildEd25519VerifyIx(
  signer: PublicKey,
  message: Uint8Array,
  signature: Uint8Array,
  instructionIndex: number,
): TransactionInstruction {
  return Ed25519Program.createInstructionWithPublicKey({
    publicKey: signer.toBytes(),
    message,
    signature,
    instructionIndex,
  });
}

export interface MatchOrdersAccounts {
  operator: PublicKey;
  exchange: PublicKey;
  collateralMint: PublicKey;
  outcomeMint: PublicKey;
  buyerCollateral: PublicKey;
  buyerOutcome: PublicKey;
  sellerCollateral: PublicKey;
  sellerOutcome: PublicKey;
  feeCollateral: PublicKey;
  buyFill: PublicKey;
  sellFill: PublicKey;
}

/** Instruction data for `match_orders`: discriminator + 2 orders + 2 sig indices. */
export function encodeMatchOrdersData(
  buyOrder: Order,
  sellOrder: Order,
  buySigIndex: number,
  sellSigIndex: number,
): Buffer {
  return Buffer.concat([
    anchorDiscriminator("match_orders"),
    serializeOrder(buyOrder),
    serializeOrder(sellOrder),
    Buffer.from([buySigIndex]),
    Buffer.from([sellSigIndex]),
  ]);
}

/** Build the `match_orders` instruction with account metas in the program's order. */
export function buildMatchOrdersIx(
  programId: PublicKey,
  accounts: MatchOrdersAccounts,
  buyOrder: Order,
  sellOrder: Order,
  buySigIndex: number,
  sellSigIndex: number,
): TransactionInstruction {
  const keys: AccountMeta[] = [
    { pubkey: accounts.operator, isSigner: true, isWritable: true },
    { pubkey: accounts.exchange, isSigner: false, isWritable: false },
    { pubkey: accounts.collateralMint, isSigner: false, isWritable: false },
    { pubkey: accounts.outcomeMint, isSigner: false, isWritable: false },
    { pubkey: accounts.buyerCollateral, isSigner: false, isWritable: true },
    { pubkey: accounts.buyerOutcome, isSigner: false, isWritable: true },
    { pubkey: accounts.sellerCollateral, isSigner: false, isWritable: true },
    { pubkey: accounts.sellerOutcome, isSigner: false, isWritable: true },
    { pubkey: accounts.feeCollateral, isSigner: false, isWritable: true },
    { pubkey: accounts.buyFill, isSigner: false, isWritable: true },
    { pubkey: accounts.sellFill, isSigner: false, isWritable: true },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({
    programId,
    keys,
    data: encodeMatchOrdersData(buyOrder, sellOrder, buySigIndex, sellSigIndex),
  });
}

export interface SettlementConfig {
  exchangeProgramId: PublicKey;
  collateralMint: PublicKey;
  outcomeMint: PublicKey;
  operator: PublicKey;
  feeAuthority: PublicKey;
}

/**
 * Assemble the full ordered instruction list for settling a match:
 *   [0] ed25519 verify (buyer), [1] ed25519 verify (seller), [2] match_orders.
 *
 * Signatures must be the makers' ed25519 signatures over `serializeOrder(order)`.
 * Buyer/seller token accounts use the associated-token convention.
 */
export function buildSettlementInstructions(
  cfg: SettlementConfig,
  match: Match,
  buySignature: Uint8Array,
  sellSignature: Uint8Array,
): TransactionInstruction[] {
  const buyer = new PublicKey(match.buy.maker);
  const seller = new PublicKey(match.sell.maker);

  const buyIx = buildEd25519VerifyIx(buyer, serializeOrder(match.buy), buySignature, 0);
  const sellIx = buildEd25519VerifyIx(seller, serializeOrder(match.sell), sellSignature, 1);

  const accounts: MatchOrdersAccounts = {
    operator: cfg.operator,
    exchange: deriveExchange(cfg.exchangeProgramId),
    collateralMint: cfg.collateralMint,
    outcomeMint: cfg.outcomeMint,
    buyerCollateral: deriveAta(buyer, cfg.collateralMint),
    buyerOutcome: deriveAta(buyer, cfg.outcomeMint),
    sellerCollateral: deriveAta(seller, cfg.collateralMint),
    sellerOutcome: deriveAta(seller, cfg.outcomeMint),
    feeCollateral: deriveAta(cfg.feeAuthority, cfg.collateralMint),
    buyFill: deriveFill(cfg.exchangeProgramId, buyer, match.buy.salt),
    sellFill: deriveFill(cfg.exchangeProgramId, seller, match.sell.salt),
  };

  const matchIx = buildMatchOrdersIx(
    cfg.exchangeProgramId,
    accounts,
    match.buy,
    match.sell,
    0,
    1,
  );

  return [buyIx, sellIx, matchIx];
}
