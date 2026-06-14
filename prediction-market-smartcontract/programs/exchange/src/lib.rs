//! Off-chain matched, on-chain settled CLOB exchange for prediction markets.
//!
//! Users sign orders off-chain; the matching engine (the `operator`) pairs a
//! BUY with a SELL of the same outcome and submits `match_orders`, which:
//!   1. verifies both makers' ed25519 signatures (instruction introspection),
//!   2. binds the traded mint to `(market, outcome)` via the conditional-token
//!      program's PDAs,
//!   3. atomically swaps shares and collateral between the two makers (the
//!      exchange PDA is a pre-approved SPL delegate on the makers' accounts),
//!   4. charges a fee on the collateral leg, and
//!   5. records replay-protection markers so each order fills at most once.
//!
//! This is the Solana analog of Polymarket's CTF Exchange. The first
//! implementation supports the BUY-vs-SELL (same outcome) match; complementary
//! mint/merge matches (BUY+BUY, SELL+SELL via the conditional-token program)
//! are a later addition.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

pub mod ed25519;
pub mod state;

use ed25519::verify_ed25519_signature;
use state::*;

declare_id!("9JjuifN5r8YRxDR7v6gChsuMwP8BV1C9pffx3Zfkc1pV");

const BPS_DENOMINATOR: u128 = 10_000;

#[program]
pub mod exchange {
    use super::*;

    /// Create the singleton exchange configuration.
    pub fn initialize_exchange(
        ctx: Context<InitializeExchange>,
        operator: Pubkey,
        fee_authority: Pubkey,
        conditional_token_program: Pubkey,
        fee_bps: u16,
    ) -> Result<()> {
        require!(fee_bps as u128 <= BPS_DENOMINATOR, ExchangeError::InvalidFee);
        let exchange = &mut ctx.accounts.exchange;
        exchange.admin = ctx.accounts.admin.key();
        exchange.operator = operator;
        exchange.fee_authority = fee_authority;
        exchange.conditional_token_program = conditional_token_program;
        exchange.fee_bps = fee_bps;
        exchange.bump = ctx.bumps.exchange;
        Ok(())
    }

    /// Settle a matched BUY/SELL pair for the same outcome.
    pub fn match_orders(
        ctx: Context<MatchOrders>,
        buy_order: Order,
        sell_order: Order,
        buy_sig_index: u8,
        sell_sig_index: u8,
    ) -> Result<()> {
        // --- Structural checks -------------------------------------------------
        require!(buy_order.side == SIDE_BUY, ExchangeError::InvalidSide);
        require!(sell_order.side == SIDE_SELL, ExchangeError::InvalidSide);
        require_keys_eq!(buy_order.market, sell_order.market, ExchangeError::MarketMismatch);
        require!(buy_order.outcome == sell_order.outcome, ExchangeError::OutcomeMismatch);
        require!(
            buy_order.outcome == OUTCOME_YES || buy_order.outcome == OUTCOME_NO,
            ExchangeError::InvalidOutcome
        );

        // --- Expiry ------------------------------------------------------------
        let now = Clock::get()?.unix_timestamp;
        require!(
            buy_order.expiration == 0 || now <= buy_order.expiration,
            ExchangeError::OrderExpired
        );
        require!(
            sell_order.expiration == 0 || now <= sell_order.expiration,
            ExchangeError::OrderExpired
        );

        // --- Bind the traded mint to (market, outcome) -------------------------
        let ct_program = ctx.accounts.exchange.conditional_token_program;
        let (condition, _) = Pubkey::find_program_address(
            &[CT_CONDITION_SEED, buy_order.market.as_ref()],
            &ct_program,
        );
        let mint_seed = if buy_order.outcome == OUTCOME_YES {
            CT_YES_MINT_SEED
        } else {
            CT_NO_MINT_SEED
        };
        let (expected_mint, _) =
            Pubkey::find_program_address(&[mint_seed, condition.as_ref()], &ct_program);
        require_keys_eq!(
            ctx.accounts.outcome_mint.key(),
            expected_mint,
            ExchangeError::OutcomeMintMismatch
        );

        // --- Token-account ownership must match the order makers ---------------
        require_keys_eq!(
            ctx.accounts.buyer_collateral.owner,
            buy_order.maker,
            ExchangeError::AccountOwnerMismatch
        );
        require_keys_eq!(
            ctx.accounts.buyer_outcome.owner,
            buy_order.maker,
            ExchangeError::AccountOwnerMismatch
        );
        require_keys_eq!(
            ctx.accounts.seller_collateral.owner,
            sell_order.maker,
            ExchangeError::AccountOwnerMismatch
        );
        require_keys_eq!(
            ctx.accounts.seller_outcome.owner,
            sell_order.maker,
            ExchangeError::AccountOwnerMismatch
        );

        // --- Verify both signatures via the Ed25519 program --------------------
        let buy_msg = buy_order.try_to_vec()?;
        verify_ed25519_signature(
            &ctx.accounts.instructions,
            buy_sig_index,
            &buy_order.maker,
            &buy_msg,
        )?;
        let sell_msg = sell_order.try_to_vec()?;
        verify_ed25519_signature(
            &ctx.accounts.instructions,
            sell_sig_index,
            &sell_order.maker,
            &sell_msg,
        )?;

        // --- Price / amount compatibility (full fill) --------------------------
        let shares = sell_order.maker_amount;
        require!(shares > 0, ExchangeError::InvalidAmount);
        require!(
            buy_order.taker_amount == shares,
            ExchangeError::AmountMismatch
        );
        let cost = sell_order.taker_amount; // executed at the seller's ask
        require!(buy_order.maker_amount >= cost, ExchangeError::PriceNotCrossed);

        // --- Fee ---------------------------------------------------------------
        let fee = (cost as u128)
            .checked_mul(ctx.accounts.exchange.fee_bps as u128)
            .ok_or(ExchangeError::MathOverflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(ExchangeError::MathOverflow)? as u64;
        let seller_proceeds = cost.checked_sub(fee).ok_or(ExchangeError::MathOverflow)?;

        // --- Settlement transfers (exchange PDA is the SPL delegate) -----------
        let bump = ctx.accounts.exchange.bump;
        let signer_seeds: &[&[u8]] = &[EXCHANGE_SEED, std::slice::from_ref(&bump)];
        let signer = &[signer_seeds];

        // Shares: seller -> buyer.
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.seller_outcome.to_account_info(),
                    to: ctx.accounts.buyer_outcome.to_account_info(),
                    authority: ctx.accounts.exchange.to_account_info(),
                },
                signer,
            ),
            shares,
        )?;

        // Collateral: buyer -> seller (net of fee).
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.buyer_collateral.to_account_info(),
                    to: ctx.accounts.seller_collateral.to_account_info(),
                    authority: ctx.accounts.exchange.to_account_info(),
                },
                signer,
            ),
            seller_proceeds,
        )?;

        // Collateral: buyer -> fee authority.
        if fee > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.buyer_collateral.to_account_info(),
                        to: ctx.accounts.fee_collateral.to_account_info(),
                        authority: ctx.accounts.exchange.to_account_info(),
                    },
                    signer,
                ),
                fee,
            )?;
        }

        // --- Replay-protection markers -----------------------------------------
        ctx.accounts.buy_fill.maker = buy_order.maker;
        ctx.accounts.buy_fill.salt = buy_order.salt;
        ctx.accounts.buy_fill.bump = ctx.bumps.buy_fill;
        ctx.accounts.sell_fill.maker = sell_order.maker;
        ctx.accounts.sell_fill.salt = sell_order.salt;
        ctx.accounts.sell_fill.bump = ctx.bumps.sell_fill;

        emit!(OrdersMatched {
            market: buy_order.market,
            outcome: buy_order.outcome,
            buyer: buy_order.maker,
            seller: sell_order.maker,
            shares,
            cost,
            fee,
        });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeExchange<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + Exchange::INIT_SPACE,
        seeds = [EXCHANGE_SEED],
        bump
    )]
    pub exchange: Box<Account<'info, Exchange>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(buy_order: Order, sell_order: Order)]
pub struct MatchOrders<'info> {
    #[account(
        mut,
        constraint = operator.key() == exchange.operator @ ExchangeError::Unauthorized
    )]
    pub operator: Signer<'info>,

    #[account(seeds = [EXCHANGE_SEED], bump = exchange.bump)]
    pub exchange: Box<Account<'info, Exchange>>,

    pub collateral_mint: Box<Account<'info, Mint>>,
    pub outcome_mint: Box<Account<'info, Mint>>,

    #[account(mut, token::mint = collateral_mint)]
    pub buyer_collateral: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = outcome_mint)]
    pub buyer_outcome: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = collateral_mint)]
    pub seller_collateral: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = outcome_mint)]
    pub seller_outcome: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = collateral_mint,
        constraint = fee_collateral.owner == exchange.fee_authority @ ExchangeError::InvalidFeeAccount
    )]
    pub fee_collateral: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = operator,
        space = 8 + OrderFill::INIT_SPACE,
        seeds = [FILL_SEED, buy_order.maker.as_ref(), &buy_order.salt.to_le_bytes()],
        bump
    )]
    pub buy_fill: Box<Account<'info, OrderFill>>,

    #[account(
        init,
        payer = operator,
        space = 8 + OrderFill::INIT_SPACE,
        seeds = [FILL_SEED, sell_order.maker.as_ref(), &sell_order.salt.to_le_bytes()],
        bump
    )]
    pub sell_fill: Box<Account<'info, OrderFill>>,

    /// CHECK: Instructions sysvar, validated by address; read for signature introspection.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct OrdersMatched {
    pub market: Pubkey,
    pub outcome: u8,
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub shares: u64,
    pub cost: u64,
    pub fee: u64,
}

#[error_code]
pub enum ExchangeError {
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Invalid fee (bps out of range)")]
    InvalidFee,
    #[msg("Invalid fee collateral account")]
    InvalidFeeAccount,
    #[msg("Order side is invalid for this match")]
    InvalidSide,
    #[msg("Orders are for different markets")]
    MarketMismatch,
    #[msg("Orders are for different outcomes")]
    OutcomeMismatch,
    #[msg("Invalid outcome")]
    InvalidOutcome,
    #[msg("Order has expired")]
    OrderExpired,
    #[msg("Outcome mint does not match (market, outcome)")]
    OutcomeMintMismatch,
    #[msg("Token account owner does not match order maker")]
    AccountOwnerMismatch,
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Buy/sell share amounts do not match")]
    AmountMismatch,
    #[msg("Prices do not cross")]
    PriceNotCrossed,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Required signature instruction is missing")]
    SignatureMissing,
    #[msg("Signature instruction is not the Ed25519 program")]
    InvalidSignatureProgram,
    #[msg("Malformed Ed25519 signature instruction")]
    MalformedSignatureIx,
    #[msg("Ed25519 signature data is not self-contained")]
    SignatureNotSelfContained,
    #[msg("Signed public key does not match the order maker")]
    SignerMismatch,
    #[msg("Signed message does not match the order")]
    MessageMismatch,
}
