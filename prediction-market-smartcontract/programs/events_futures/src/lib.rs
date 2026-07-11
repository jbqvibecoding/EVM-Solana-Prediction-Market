//! Spark markets: event-futures protocol (42.space-style) for Solana.
//!
//! Each market prices every outcome on its own power curve `P(s) = m·s^n`
//! (MVP: integer n ∈ {1, 2}; quadratic recommended). Buying **mints** outcome
//! tokens along the curve, selling **redeems** them back along the curve, and
//! settlement is **parimutuel**: on resolution all outcome pools merge and
//! winning-token holders split the combined pool pro-rata — losing outcomes go
//! to zero. Fees (bps of every mint) accrue to the protocol treasury.
//!
//! The instruction names, argument order, and account order are a stable ABI
//! consumed by the frontend builders in `prediction-market`
//! `src/lib/solana/spark.ts` — do not reorder them.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("7sech8m8biTTjb6e2UpdGx6wnnSqjMVyRFEVGPSvZ6sc");

pub const PROTOCOL_STATE_SEED: &[u8] = b"protocol_state";
pub const MARKET_SEED: &[u8] = b"market";
pub const OUTCOME_SEED: &[u8] = b"outcome";
pub const OUTCOME_MINT_SEED: &[u8] = b"outcome_mint";
pub const MARKET_AUTH_SEED: &[u8] = b"market_auth";
pub const VAULT_SEED: &[u8] = b"vault";

/// Outcome mints share USDC's 6 decimals so amounts map 1:1.
pub const OUTCOME_DECIMALS: u8 = 6;
/// Supply cap per outcome so s^(n+1) fits u128 for n ≤ 2 (6e12^3 ≈ 2.2e38 < u128::MAX).
pub const MAX_OUTCOME_SUPPLY: u64 = 6_000_000_000_000;
/// Bisection iterations for the USDC → tokens inverse (matches the client).
pub const BISECTION_MAX_ITERATIONS: u32 = 64;
pub const MAX_TITLE_LEN: usize = 128;
pub const MAX_LABEL_LEN: usize = 64;
pub const MAX_OUTCOMES: u8 = 8;
pub const BPS_DENOMINATOR: u64 = 10_000;

// ---------------------------------------------------------------------------
// Curve math: cost to move supply s1 -> s2 along P(s) = m·s^n is
//   m/(n+1) · (s2^(n+1) − s1^(n+1))
// with m = m_num/m_den. All in u128 checked arithmetic; the client mirrors
// this exactly (bigint), including flooring, so previews match on-chain.
// ---------------------------------------------------------------------------

fn pow_u128(base: u128, exp: u32) -> Option<u128> {
    let mut result: u128 = 1;
    for _ in 0..exp {
        result = result.checked_mul(base)?;
    }
    Some(result)
}

/// Mint cost (base-unit USDC) to move an outcome's supply from `s1` to `s2`.
pub fn curve_cost(s1: u64, s2: u64, m_num: u64, m_den: u64, n: u32) -> Result<u64> {
    if s2 <= s1 {
        return Ok(0);
    }
    let n_plus_1 = n.checked_add(1).ok_or(SparkError::MathOverflow)?;
    let s2_pow = pow_u128(s2 as u128, n_plus_1).ok_or(SparkError::MathOverflow)?;
    let s1_pow = pow_u128(s1 as u128, n_plus_1).ok_or(SparkError::MathOverflow)?;
    let diff = s2_pow.checked_sub(s1_pow).ok_or(SparkError::MathOverflow)?;
    let numerator = diff
        .checked_mul(m_num as u128)
        .ok_or(SparkError::MathOverflow)?;
    let denominator = (m_den as u128)
        .checked_mul(n_plus_1 as u128)
        .ok_or(SparkError::MathOverflow)?;
    let cost = numerator
        .checked_div(denominator)
        .ok_or(SparkError::MathOverflow)?;
    u64::try_from(cost).map_err(|_| SparkError::MathOverflow.into())
}

/// Max tokens mintable from supply `s1` with `usdc_in`, by bisection over the
/// monotonic cost integral (mirrors the client's `sparkTokensForUsdc`).
pub fn tokens_for_usdc(s1: u64, usdc_in: u64, m_num: u64, m_den: u64, n: u32) -> Result<u64> {
    if usdc_in == 0 {
        return Ok(0);
    }
    let cap = MAX_OUTCOME_SUPPLY.saturating_sub(s1);
    if cap == 0 {
        return Ok(0);
    }

    // Grow the upper bracket until the cost exceeds the target (or we hit cap).
    let mut hi: u64 = usdc_in.saturating_add(1).min(cap);
    while curve_cost(s1, s1.saturating_add(hi), m_num, m_den, n)? < usdc_in && hi < cap {
        hi = hi.saturating_mul(2).min(cap);
    }

    let mut lo: u64 = 0;
    for _ in 0..BISECTION_MAX_ITERATIONS {
        if lo >= hi {
            break;
        }
        let mid = lo + (hi - lo + 1) / 2;
        if curve_cost(s1, s1 + mid, m_num, m_den, n)? <= usdc_in {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    Ok(lo)
}

#[program]
pub mod events_futures {
    use super::*;

    /// Create the singleton protocol state (admin, fee bps, treasury).
    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        fee_bps: u16,
        treasury: Pubkey,
    ) -> Result<()> {
        require!(u64::from(fee_bps) < BPS_DENOMINATOR, SparkError::InvalidFee);
        let state = &mut ctx.accounts.protocol_state;
        state.admin = ctx.accounts.admin.key();
        state.fee_bps = fee_bps;
        state.market_count = 0;
        state.treasury = treasury;
        state.paused = false;
        state.bump = ctx.bumps.protocol_state;
        Ok(())
    }

    /// Create a spark market: the Market record, its authority PDA and the
    /// USDC vault. Outcomes are added afterwards with `add_outcome`.
    pub fn create_market(
        ctx: Context<CreateMarket>,
        market_id: u64,
        title: String,
        m_num: u64,
        m_den: u64,
        n_num: u64,
        n_den: u64,
    ) -> Result<()> {
        require!(!ctx.accounts.protocol_state.paused, SparkError::ProtocolPaused);
        require!(title.len() <= MAX_TITLE_LEN, SparkError::TitleTooLong);
        require!(m_num > 0 && m_den > 0, SparkError::InvalidCurve);
        // MVP: integer exponent n ∈ {1, 2} (quadratic recommended).
        require!(n_den == 1 && (n_num == 1 || n_num == 2), SparkError::InvalidCurve);

        let market = &mut ctx.accounts.market;
        market.market_id = market_id;
        market.creator = ctx.accounts.creator.key();
        market.status = MarketStatus::Active;
        market.outcome_count = 0;
        market.winning_outcome = None;
        market.total_usdc_in_curves = 0;
        market.total_fees_collected = 0;
        market.fees_withdrawn = 0;
        market.claim_pool_remaining = 0;
        market.collateral_mint = ctx.accounts.collateral_mint.key();
        market.vault = ctx.accounts.vault.key();
        market.title = title;
        market.curve_m_num = m_num;
        market.curve_m_den = m_den;
        market.curve_n_num = n_num;
        market.curve_n_den = n_den;
        market.bump = ctx.bumps.market;
        market.auth_bump = ctx.bumps.market_authority;
        market.vault_bump = ctx.bumps.vault;

        let state = &mut ctx.accounts.protocol_state;
        state.market_count = state
            .market_count
            .checked_add(1)
            .ok_or(SparkError::MathOverflow)?;

        emit!(SparkMarketCreated {
            market_id,
            creator: market.creator,
            collateral_mint: market.collateral_mint,
            vault: market.vault,
            title: market.title.clone(),
            m_num,
            m_den,
            n_num,
            n_den,
        });
        Ok(())
    }

    /// Add the next outcome (sequential index) with its own pool + SPL mint.
    pub fn add_outcome(
        ctx: Context<AddOutcome>,
        market_id: u64,
        outcome_index: u8,
        label: String,
    ) -> Result<()> {
        require!(label.len() <= MAX_LABEL_LEN, SparkError::LabelTooLong);
        let market = &mut ctx.accounts.market;
        require!(market.status == MarketStatus::Active, SparkError::MarketNotActive);
        require!(
            ctx.accounts.admin.key() == market.creator,
            SparkError::Unauthorized
        );
        require!(outcome_index == market.outcome_count, SparkError::InvalidOutcome);
        require!(market.outcome_count < MAX_OUTCOMES, SparkError::InvalidOutcome);

        let pool = &mut ctx.accounts.outcome_pool;
        pool.market = market.key();
        pool.outcome_index = outcome_index;
        pool.mint = ctx.accounts.outcome_mint.key();
        pool.current_supply = 0;
        pool.usdc_in_curve = 0;
        pool.label = label;
        pool.mint_bump = ctx.bumps.outcome_mint;
        pool.bump = ctx.bumps.outcome_pool;

        market.outcome_count = market
            .outcome_count
            .checked_add(1)
            .ok_or(SparkError::MathOverflow)?;

        emit!(SparkOutcomeAdded {
            market_id,
            outcome_index,
            mint: pool.mint,
            label: pool.label.clone(),
        });
        Ok(())
    }

    /// Buy: pay `amount` USDC; net of fee mints outcome tokens along the curve.
    pub fn mint_outcome_tokens(
        ctx: Context<Trade>,
        market_id: u64,
        outcome_index: u8,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, SparkError::InvalidAmount);
        require!(!ctx.accounts.protocol_state.paused, SparkError::ProtocolPaused);
        require!(
            ctx.accounts.market.status == MarketStatus::Active,
            SparkError::MarketNotActive
        );

        let fee = amount
            .checked_mul(u64::from(ctx.accounts.protocol_state.fee_bps))
            .ok_or(SparkError::MathOverflow)?
            / BPS_DENOMINATOR;
        let net = amount.checked_sub(fee).ok_or(SparkError::MathOverflow)?;

        let market = &ctx.accounts.market;
        let s1 = ctx.accounts.outcome_pool.current_supply;
        let tokens = tokens_for_usdc(
            s1,
            net,
            market.curve_m_num,
            market.curve_m_den,
            market.curve_n_num as u32,
        )?;
        require!(tokens > 0, SparkError::InsufficientAmount);
        require!(
            s1.checked_add(tokens).ok_or(SparkError::MathOverflow)? <= MAX_OUTCOME_SUPPLY,
            SparkError::SupplyCapExceeded
        );

        // Collateral: user -> vault (gross amount; the fee stays in the vault
        // until collect_fees sweeps it to the treasury).
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_collateral.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        // Mint outcome tokens to the user, signed by the market authority PDA.
        let market_id_bytes = market_id.to_le_bytes();
        let auth_bump = ctx.accounts.market.auth_bump;
        let signer_seeds: &[&[&[u8]]] =
            &[&[MARKET_AUTH_SEED, market_id_bytes.as_ref(), &[auth_bump]]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.outcome_mint.to_account_info(),
                    to: ctx.accounts.user_outcome.to_account_info(),
                    authority: ctx.accounts.market_authority.to_account_info(),
                },
                signer_seeds,
            ),
            tokens,
        )?;

        let pool = &mut ctx.accounts.outcome_pool;
        pool.current_supply = pool
            .current_supply
            .checked_add(tokens)
            .ok_or(SparkError::MathOverflow)?;
        pool.usdc_in_curve = pool
            .usdc_in_curve
            .checked_add(net)
            .ok_or(SparkError::MathOverflow)?;
        let market = &mut ctx.accounts.market;
        market.total_usdc_in_curves = market
            .total_usdc_in_curves
            .checked_add(net)
            .ok_or(SparkError::MathOverflow)?;
        market.total_fees_collected = market
            .total_fees_collected
            .checked_add(fee)
            .ok_or(SparkError::MathOverflow)?;

        emit!(SparkTokensMinted {
            market_id,
            user: ctx.accounts.user.key(),
            outcome_index,
            usdc_amount: amount,
            fee,
            tokens_minted: tokens,
        });
        Ok(())
    }

    /// Sell: burn `amount` outcome tokens; USDC comes back along the curve.
    pub fn redeem_outcome_tokens(
        ctx: Context<Trade>,
        market_id: u64,
        outcome_index: u8,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, SparkError::InvalidAmount);
        require!(
            ctx.accounts.market.status == MarketStatus::Active,
            SparkError::MarketNotActive
        );
        let pool_supply = ctx.accounts.outcome_pool.current_supply;
        require!(amount <= pool_supply, SparkError::InvalidAmount);

        let market = &ctx.accounts.market;
        let proceeds = curve_cost(
            pool_supply - amount,
            pool_supply,
            market.curve_m_num,
            market.curve_m_den,
            market.curve_n_num as u32,
        )?
        // Flooring across partial mints/redeems can leave the integral a unit
        // above what this pool actually holds — never pay out more than it has.
        .min(ctx.accounts.outcome_pool.usdc_in_curve);
        require!(proceeds > 0, SparkError::InsufficientAmount);

        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.outcome_mint.to_account_info(),
                    from: ctx.accounts.user_outcome.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        let market_id_bytes = market_id.to_le_bytes();
        let auth_bump = ctx.accounts.market.auth_bump;
        let signer_seeds: &[&[&[u8]]] =
            &[&[MARKET_AUTH_SEED, market_id_bytes.as_ref(), &[auth_bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.user_collateral.to_account_info(),
                    authority: ctx.accounts.market_authority.to_account_info(),
                },
                signer_seeds,
            ),
            proceeds,
        )?;

        let pool = &mut ctx.accounts.outcome_pool;
        pool.current_supply -= amount;
        pool.usdc_in_curve -= proceeds;
        let market = &mut ctx.accounts.market;
        market.total_usdc_in_curves = market
            .total_usdc_in_curves
            .checked_sub(proceeds)
            .ok_or(SparkError::MathOverflow)?;

        emit!(SparkTokensRedeemed {
            market_id,
            user: ctx.accounts.user.key(),
            outcome_index,
            tokens_burned: amount,
            usdc_returned: proceeds,
        });
        Ok(())
    }

    /// Record the winning outcome (protocol admin only, MVP). Trading stops;
    /// the combined curve pool becomes claimable by winning-token holders.
    pub fn resolve_market(
        ctx: Context<ResolveMarket>,
        market_id: u64,
        winning_outcome: u8,
    ) -> Result<()> {
        require!(
            ctx.accounts.authority.key() == ctx.accounts.protocol_state.admin,
            SparkError::Unauthorized
        );
        let market = &mut ctx.accounts.market;
        require!(market.status == MarketStatus::Active, SparkError::MarketNotActive);
        require!(winning_outcome < market.outcome_count, SparkError::InvalidOutcome);

        market.status = MarketStatus::Resolved;
        market.winning_outcome = Some(winning_outcome);
        // Parimutuel: every outcome's curve USDC merges into one claim pool.
        market.claim_pool_remaining = market.total_usdc_in_curves;

        emit!(SparkMarketResolved {
            market_id,
            winning_outcome,
            total_pool: market.claim_pool_remaining,
        });
        Ok(())
    }

    /// After resolution: burn the caller's whole winning balance for a
    /// pro-rata share of the merged pool. Decrementing pool and supply
    /// together keeps sequential claims exact (telescoping).
    pub fn claim_winnings(
        ctx: Context<Trade>,
        market_id: u64,
        outcome_index: u8,
    ) -> Result<()> {
        let market = &ctx.accounts.market;
        require!(market.status == MarketStatus::Resolved, SparkError::MarketNotResolved);
        require!(
            market.winning_outcome == Some(outcome_index),
            SparkError::NotWinningOutcome
        );

        let balance = ctx.accounts.user_outcome.amount;
        require!(balance > 0, SparkError::NoTokensToClaim);
        let winning_supply = ctx.accounts.outcome_pool.current_supply;
        require!(winning_supply > 0, SparkError::NoTokensToClaim);

        let payout = u64::try_from(
            (balance as u128)
                .checked_mul(market.claim_pool_remaining as u128)
                .ok_or(SparkError::MathOverflow)?
                / (winning_supply as u128),
        )
        .map_err(|_| SparkError::MathOverflow)?;

        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.outcome_mint.to_account_info(),
                    from: ctx.accounts.user_outcome.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            balance,
        )?;

        if payout > 0 {
            let market_id_bytes = market_id.to_le_bytes();
            let auth_bump = ctx.accounts.market.auth_bump;
            let signer_seeds: &[&[&[u8]]] =
                &[&[MARKET_AUTH_SEED, market_id_bytes.as_ref(), &[auth_bump]]];
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.user_collateral.to_account_info(),
                        authority: ctx.accounts.market_authority.to_account_info(),
                    },
                    signer_seeds,
                ),
                payout,
            )?;
        }

        let pool = &mut ctx.accounts.outcome_pool;
        pool.current_supply -= balance;
        let market = &mut ctx.accounts.market;
        market.claim_pool_remaining = market
            .claim_pool_remaining
            .checked_sub(payout)
            .ok_or(SparkError::MathOverflow)?;

        emit!(SparkWinningsClaimed {
            market_id,
            user: ctx.accounts.user.key(),
            tokens_burned: balance,
            payout,
        });
        Ok(())
    }

    /// Sweep accrued (un-withdrawn) protocol fees from the vault to the treasury.
    pub fn collect_fees(ctx: Context<CollectFees>, market_id: u64) -> Result<()> {
        require!(
            ctx.accounts.admin.key() == ctx.accounts.protocol_state.admin,
            SparkError::Unauthorized
        );
        let market = &ctx.accounts.market;
        let collectable = market
            .total_fees_collected
            .checked_sub(market.fees_withdrawn)
            .ok_or(SparkError::MathOverflow)?;
        require!(collectable > 0, SparkError::InsufficientAmount);

        let market_id_bytes = market_id.to_le_bytes();
        let auth_bump = market.auth_bump;
        let signer_seeds: &[&[&[u8]]] =
            &[&[MARKET_AUTH_SEED, market_id_bytes.as_ref(), &[auth_bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.treasury_collateral.to_account_info(),
                    authority: ctx.accounts.market_authority.to_account_info(),
                },
                signer_seeds,
            ),
            collectable,
        )?;

        let market = &mut ctx.accounts.market;
        market.fees_withdrawn = market
            .fees_withdrawn
            .checked_add(collectable)
            .ok_or(SparkError::MathOverflow)?;

        emit!(SparkFeesCollected {
            market_id,
            amount: collectable,
        });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub enum MarketStatus {
    Active,
    ProposalPending,
    Resolved,
    Cancelled,
}

#[account]
#[derive(InitSpace)]
pub struct ProtocolState {
    pub admin: Pubkey,
    pub fee_bps: u16,
    pub market_count: u64,
    pub treasury: Pubkey,
    pub paused: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct SparkMarket {
    pub market_id: u64,
    pub creator: Pubkey,
    pub status: MarketStatus,
    pub outcome_count: u8,
    pub winning_outcome: Option<u8>,
    /// USDC currently backing outcome curves (mint adds net, redeem subtracts).
    pub total_usdc_in_curves: u64,
    /// Cumulative fees accrued from mints.
    pub total_fees_collected: u64,
    /// Portion of fees already swept to the treasury.
    pub fees_withdrawn: u64,
    /// Set at resolve to the merged pool; decremented as winners claim.
    pub claim_pool_remaining: u64,
    pub collateral_mint: Pubkey,
    pub vault: Pubkey,
    #[max_len(128)]
    pub title: String,
    pub curve_m_num: u64,
    pub curve_m_den: u64,
    pub curve_n_num: u64,
    pub curve_n_den: u64,
    pub bump: u8,
    pub auth_bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct OutcomePool {
    pub market: Pubkey,
    pub outcome_index: u8,
    pub mint: Pubkey,
    pub current_supply: u64,
    pub usdc_in_curve: u64,
    #[max_len(64)]
    pub label: String,
    pub mint_bump: u8,
    pub bump: u8,
}

// ---------------------------------------------------------------------------
// Accounts (ordering is ABI — mirrored by the frontend builders)
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + ProtocolState::INIT_SPACE,
        seeds = [PROTOCOL_STATE_SEED],
        bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        mut,
        seeds = [PROTOCOL_STATE_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    #[account(
        init,
        payer = creator,
        space = 8 + SparkMarket::INIT_SPACE,
        seeds = [MARKET_SEED, market_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub market: Account<'info, SparkMarket>,

    /// CHECK: PDA that signs for the vault and all outcome mints.
    #[account(
        seeds = [MARKET_AUTH_SEED, market_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub market_authority: UncheckedAccount<'info>,

    pub collateral_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = creator,
        seeds = [VAULT_SEED, market_id.to_le_bytes().as_ref()],
        bump,
        token::mint = collateral_mint,
        token::authority = market_authority,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(market_id: u64, outcome_index: u8)]
pub struct AddOutcome<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [MARKET_SEED, market_id.to_le_bytes().as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, SparkMarket>,

    #[account(
        init,
        payer = admin,
        space = 8 + OutcomePool::INIT_SPACE,
        seeds = [OUTCOME_SEED, market_id.to_le_bytes().as_ref(), &[outcome_index]],
        bump,
    )]
    pub outcome_pool: Account<'info, OutcomePool>,

    #[account(
        init,
        payer = admin,
        seeds = [OUTCOME_MINT_SEED, market_id.to_le_bytes().as_ref(), &[outcome_index]],
        bump,
        mint::decimals = OUTCOME_DECIMALS,
        mint::authority = market_authority,
    )]
    pub outcome_mint: Box<Account<'info, Mint>>,

    /// CHECK: PDA mint authority for all outcome mints of this market.
    #[account(
        seeds = [MARKET_AUTH_SEED, market_id.to_le_bytes().as_ref()],
        bump = market.auth_bump,
    )]
    pub market_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(market_id: u64, outcome_index: u8)]
pub struct Trade<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [PROTOCOL_STATE_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    #[account(
        mut,
        seeds = [MARKET_SEED, market_id.to_le_bytes().as_ref()],
        bump = market.bump,
        has_one = vault,
    )]
    pub market: Account<'info, SparkMarket>,

    #[account(
        mut,
        seeds = [OUTCOME_SEED, market_id.to_le_bytes().as_ref(), &[outcome_index]],
        bump = outcome_pool.bump,
        constraint = outcome_pool.mint == outcome_mint.key() @ SparkError::InvalidOutcome,
    )]
    pub outcome_pool: Account<'info, OutcomePool>,

    #[account(
        mut,
        seeds = [OUTCOME_MINT_SEED, market_id.to_le_bytes().as_ref(), &[outcome_index]],
        bump = outcome_pool.mint_bump,
    )]
    pub outcome_mint: Box<Account<'info, Mint>>,

    /// CHECK: PDA authority over the vault and outcome mints.
    #[account(
        seeds = [MARKET_AUTH_SEED, market_id.to_le_bytes().as_ref()],
        bump = market.auth_bump,
    )]
    pub market_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, market_id.to_le_bytes().as_ref()],
        bump = market.vault_bump,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = user_collateral.mint == market.collateral_mint @ SparkError::InvalidCollateral,
        constraint = user_collateral.owner == user.key() @ SparkError::InvalidCollateral,
    )]
    pub user_collateral: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = outcome_mint,
        associated_token::authority = user,
    )]
    pub user_outcome: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct ResolveMarket<'info> {
    pub authority: Signer<'info>,

    #[account(
        seeds = [PROTOCOL_STATE_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    #[account(
        mut,
        seeds = [MARKET_SEED, market_id.to_le_bytes().as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, SparkMarket>,
}

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct CollectFees<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [PROTOCOL_STATE_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    #[account(
        mut,
        seeds = [MARKET_SEED, market_id.to_le_bytes().as_ref()],
        bump = market.bump,
        has_one = vault,
    )]
    pub market: Account<'info, SparkMarket>,

    /// CHECK: PDA authority over the vault.
    #[account(
        seeds = [MARKET_AUTH_SEED, market_id.to_le_bytes().as_ref()],
        bump = market.auth_bump,
    )]
    pub market_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, market_id.to_le_bytes().as_ref()],
        bump = market.vault_bump,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = treasury_collateral.mint == market.collateral_mint @ SparkError::InvalidCollateral,
        constraint = treasury_collateral.owner == protocol_state.treasury @ SparkError::InvalidCollateral,
    )]
    pub treasury_collateral: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

// ---------------------------------------------------------------------------
// Events & errors
// ---------------------------------------------------------------------------

#[event]
pub struct SparkMarketCreated {
    pub market_id: u64,
    pub creator: Pubkey,
    pub collateral_mint: Pubkey,
    pub vault: Pubkey,
    pub title: String,
    pub m_num: u64,
    pub m_den: u64,
    pub n_num: u64,
    pub n_den: u64,
}

#[event]
pub struct SparkOutcomeAdded {
    pub market_id: u64,
    pub outcome_index: u8,
    pub mint: Pubkey,
    pub label: String,
}

#[event]
pub struct SparkTokensMinted {
    pub market_id: u64,
    pub user: Pubkey,
    pub outcome_index: u8,
    pub usdc_amount: u64,
    /// Protocol fee taken from usdc_amount; net into the curve = amount − fee.
    pub fee: u64,
    pub tokens_minted: u64,
}

#[event]
pub struct SparkTokensRedeemed {
    pub market_id: u64,
    pub user: Pubkey,
    pub outcome_index: u8,
    pub tokens_burned: u64,
    pub usdc_returned: u64,
}

#[event]
pub struct SparkMarketResolved {
    pub market_id: u64,
    pub winning_outcome: u8,
    pub total_pool: u64,
}

#[event]
pub struct SparkWinningsClaimed {
    pub market_id: u64,
    pub user: Pubkey,
    /// Winning tokens burned by this claim (decrements the winning supply).
    pub tokens_burned: u64,
    pub payout: u64,
}

#[event]
pub struct SparkFeesCollected {
    pub market_id: u64,
    pub amount: u64,
}

#[error_code]
pub enum SparkError {
    #[msg("Protocol is paused")]
    ProtocolPaused, // 6000
    #[msg("Market is not active")]
    MarketNotActive, // 6001
    #[msg("Market is not resolved yet")]
    MarketNotResolved, // 6002
    #[msg("Not the winning outcome")]
    NotWinningOutcome, // 6003
    #[msg("Amount must be greater than zero")]
    InvalidAmount, // 6004
    #[msg("Amount too small for the curve")]
    InsufficientAmount, // 6005
    #[msg("Math overflow")]
    MathOverflow, // 6006
    #[msg("Unauthorized")]
    Unauthorized, // 6007
    #[msg("Invalid outcome index")]
    InvalidOutcome, // 6008
    #[msg("Invalid curve parameters")]
    InvalidCurve, // 6009
    #[msg("Invalid fee")]
    InvalidFee, // 6010
    #[msg("Title too long")]
    TitleTooLong, // 6011
    #[msg("Label too long")]
    LabelTooLong, // 6012
    #[msg("Outcome supply cap exceeded")]
    SupplyCapExceeded, // 6013
    #[msg("Invalid collateral account")]
    InvalidCollateral, // 6014
    #[msg("No tokens to claim")]
    NoTokensToClaim, // 6015
}

#[cfg(test)]
mod tests {
    use super::*;

    // Mirror of the frontend test vectors (tests/unit/solanaSpark.test.ts):
    // P(s) = s²/1e12 → cost(s1→s2) = (s2³ − s1³)/3e12.
    const M_NUM: u64 = 1;
    const M_DEN: u64 = 1_000_000_000_000;
    const N: u32 = 2;

    #[test]
    fn curve_cost_matches_closed_form() {
        assert_eq!(curve_cost(0, 30_000, M_NUM, M_DEN, N).unwrap(), 9);
        assert_eq!(curve_cost(30_000, 60_000, M_NUM, M_DEN, N).unwrap(), 63);
        assert_eq!(curve_cost(500, 500, M_NUM, M_DEN, N).unwrap(), 0);
        assert_eq!(curve_cost(600, 500, M_NUM, M_DEN, N).unwrap(), 0);
    }

    #[test]
    fn bisection_matches_frontend_vector() {
        // 9 USDC mints 31072 tokens under integer flooring (31072³ < 3e13).
        let tokens = tokens_for_usdc(0, 9, M_NUM, M_DEN, N).unwrap();
        assert_eq!(tokens, 31_072);
        assert!(curve_cost(0, tokens, M_NUM, M_DEN, N).unwrap() <= 9);
        assert!(curve_cost(0, tokens + 1, M_NUM, M_DEN, N).unwrap() > 9);
        assert_eq!(tokens_for_usdc(0, 0, M_NUM, M_DEN, N).unwrap(), 0);
    }

    #[test]
    fn supply_cap_is_enforced_by_bisection() {
        let near_cap = MAX_OUTCOME_SUPPLY - 10;
        let tokens = tokens_for_usdc(near_cap, u64::MAX / 2, M_NUM, M_DEN, N).unwrap();
        assert!(tokens <= 10);
        // At the full cap the u128 pow still cannot overflow/panic; the cost
        // just exceeds u64 (≈7.2e25 base units) and errors gracefully.
        assert!(curve_cost(0, MAX_OUTCOME_SUPPLY, M_NUM, M_DEN, N).is_err());
        // A supply where the cost fits u64 computes fine (1e10³/3e12 ≈ 3.3e17).
        assert_eq!(
            curve_cost(0, 10_000_000_000, M_NUM, M_DEN, N).unwrap(),
            333_333_333_333_333_333,
        );
    }
}
