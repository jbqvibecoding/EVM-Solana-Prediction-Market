use anchor_lang::prelude::*;

/// Order side.
pub const SIDE_BUY: u8 = 0;
pub const SIDE_SELL: u8 = 1;

/// Outcome index, matching the conditional-token program.
pub const OUTCOME_YES: u8 = 0;
pub const OUTCOME_NO: u8 = 1;

/// Seeds shared with the `conditional_token` program, used to re-derive and
/// bind the traded outcome mint to `(market, outcome)`.
pub const CT_CONDITION_SEED: &[u8] = b"condition";
pub const CT_YES_MINT_SEED: &[u8] = b"yes";
pub const CT_NO_MINT_SEED: &[u8] = b"no";

pub const EXCHANGE_SEED: &[u8] = b"exchange";
pub const FILL_SEED: &[u8] = b"fill";

/// Global exchange configuration (singleton PDA).
#[account]
#[derive(InitSpace)]
pub struct Exchange {
    /// Admin able to update configuration.
    pub admin: Pubkey,
    /// The matching engine allowed to submit settlements.
    pub operator: Pubkey,
    /// Receives trading fees (owner of the fee collateral token account).
    pub fee_authority: Pubkey,
    /// The conditional-token program, used to validate the traded outcome mint.
    pub conditional_token_program: Pubkey,
    /// Fee charged on the collateral leg, in basis points.
    pub fee_bps: u16,
    pub bump: u8,
}

/// A signed off-chain order. The maker signs the borsh serialization of this
/// struct; the exchange verifies the signature via the Ed25519 program.
///
/// Semantics:
/// - BUY : maker gives `maker_amount` collateral, wants `taker_amount` shares.
/// - SELL: maker gives `maker_amount` shares,    wants `taker_amount` collateral.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Order {
    /// Unique per-order id (also the replay-protection key together with maker).
    pub salt: u64,
    /// Order owner / signer; also the owner of the funded token accounts.
    pub maker: Pubkey,
    /// Market this order trades on.
    pub market: Pubkey,
    /// Outcome being traded: 0 = YES, 1 = NO.
    pub outcome: u8,
    /// 0 = BUY, 1 = SELL.
    pub side: u8,
    /// Amount the maker gives.
    pub maker_amount: u64,
    /// Amount the maker wants in return.
    pub taker_amount: u64,
    /// Unix expiration timestamp; 0 means no expiry.
    pub expiration: i64,
    /// Maker's acceptable fee cap, in basis points (informational; the exchange
    /// charges `Exchange::fee_bps`).
    pub fee_rate_bps: u16,
}

/// Marker PDA created on first fill of an order, preventing replays.
/// Seeds: `[FILL_SEED, maker, salt]`.
#[account]
#[derive(InitSpace)]
pub struct OrderFill {
    pub maker: Pubkey,
    pub salt: u64,
    pub bump: u8,
}
