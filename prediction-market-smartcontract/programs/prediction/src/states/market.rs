use crate::constants::MARKET_SEED;
use anchor_lang::prelude::*;

/// Lifecycle of a prediction market.
///
/// `Prepare`  – created, tokens minted, awaiting activation/liquidity.
/// `Active`   – open for trading / order settlement.
/// `Resolved` – outcome decided by the Switchboard oracle (`get_oracle_res`).
#[derive(
    AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug, Default,
)]
pub enum MarketStatus {
    #[default]
    Prepare,
    Active,
    Resolved,
}

/// On-chain account describing a single binary (YES/NO) prediction market.
///
/// Pricing/trading is handled off-chain by the matching engine and settled by
/// the exchange program; this account stores the market metadata, the
/// Switchboard feed it resolves against, and the resolved outcome.
#[account]
#[derive(InitSpace, Debug)]
pub struct Market {
    /// Wallet that created the market.
    pub creator: Pubkey,
    /// Switchboard pull-feed used to resolve the market.
    pub feed: Pubkey,
    /// Target value compared against the feed at resolution time.
    pub value: f64,
    /// Comparison mode: 0 => `value > feed`, 1 => `value == feed`, 2 => `value < feed`.
    pub range: u8,

    /// YES outcome SPL mint.
    pub token_a_mint: Pubkey,
    /// NO outcome SPL mint.
    pub token_b_mint: Pubkey,

    /// Initial YES/NO token amounts (whole units, pre-decimals).
    pub token_a_amount: u64,
    pub token_b_amount: u64,
    /// Reference prices recorded at creation (lamports per token).
    pub token_price_a: u64,
    pub token_price_b: u64,
    /// Collateral reserve backing the market (lamports).
    pub total_reserve: u64,

    /// Market end / resolution timestamp (unix seconds).
    pub date: i64,
    /// Current lifecycle status.
    pub market_status: MarketStatus,
    /// Resolved outcome: `true` => YES wins, `false` => NO wins.
    pub result: bool,
    /// PDA bump for the market account (also used as mint authority signer).
    pub bump: u8,
}

/// Parameters supplied when creating a market (`init_market`).
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct MarketParams {
    /// Human-readable unique id; also the PDA seed for the market.
    pub market_id: String,
    pub value: f64,
    pub range: u8,
    /// Initial token amount minted per outcome (whole units).
    pub token_amount: u64,
    /// Reference token price (lamports).
    pub token_price: u64,
    /// Resolution timestamp (unix seconds).
    pub date: i64,

    /// YES token metadata.
    pub name_a: Option<String>,
    pub symbol_a: Option<String>,
    pub url_a: Option<String>,
    /// NO token metadata.
    pub name_b: Option<String>,
    pub symbol_b: Option<String>,
    pub url_b: Option<String>,
}

impl Market {
    /// Signer seeds for the market PDA, used when the market acts as the
    /// mint/transfer authority. Mirrors the seeds in `init_market`/`mint_token`:
    /// `[MARKET_SEED, market_id, bump]`.
    pub fn get_signer<'a>(bump: &'a u8, market_id: &'a [u8]) -> [&'a [u8]; 3] {
        [MARKET_SEED.as_bytes(), market_id, std::slice::from_ref(bump)]
    }

    /// Populate market fields at creation time.
    #[allow(clippy::too_many_arguments)]
    pub fn update_market_settings(
        &mut self,
        value: f64,
        range: u8,
        creator: Pubkey,
        feed: Pubkey,
        token_a_mint: Pubkey,
        token_b_mint: Pubkey,
        token_amount: u64,
        token_price: u64,
        date: i64,
    ) -> Result<()> {
        self.value = value;
        self.range = range;
        self.creator = creator;
        self.feed = feed;
        self.token_a_mint = token_a_mint;
        self.token_b_mint = token_b_mint;
        self.token_a_amount = token_amount;
        self.token_b_amount = token_amount;
        self.token_price_a = token_price;
        self.token_price_b = token_price;
        self.total_reserve = 0;
        self.date = date;
        self.market_status = MarketStatus::Prepare;
        self.result = false;
        Ok(())
    }

    /// Transition the market to a new lifecycle status.
    pub fn update_market_status(&mut self, status: MarketStatus) {
        self.market_status = status;
    }
}
