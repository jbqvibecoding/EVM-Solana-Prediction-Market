import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { Settler } from "./engine.js";
import { Match } from "./orderbook.js";
import { buildSettlementInstructions } from "./settlement.js";

export interface SolanaSettlerConfig {
  exchangeProgramId: PublicKey;
  conditionalTokenProgramId: PublicKey;
  collateralMint: PublicKey;
  feeAuthority: PublicKey;
}

/**
 * Settler that submits matches to the on-chain exchange. The operator keypair
 * signs and pays for the transaction (so makers trade gas-free); the exchange
 * PDA, a pre-approved SPL delegate on the makers' accounts, moves the funds.
 */
export class SolanaSettler implements Settler {
  constructor(
    private readonly connection: Connection,
    private readonly operator: Keypair,
    private readonly config: SolanaSettlerConfig,
  ) {}

  async settle(
    match: Match,
    buySignature: Uint8Array,
    sellSignature: Uint8Array,
  ): Promise<string> {
    const ixs = buildSettlementInstructions(
      {
        exchangeProgramId: this.config.exchangeProgramId,
        conditionalTokenProgramId: this.config.conditionalTokenProgramId,
        collateralMint: this.config.collateralMint,
        operator: this.operator.publicKey,
        feeAuthority: this.config.feeAuthority,
      },
      match,
      buySignature,
      sellSignature,
    );
    const tx = new Transaction().add(...ixs);
    return sendAndConfirmTransaction(this.connection, tx, [this.operator], {
      commitment: "confirmed",
    });
  }
}
