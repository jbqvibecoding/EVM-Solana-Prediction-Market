//! Minimal conditional-token program for binary (YES/NO) prediction markets.
//!
//! Each market has a `Condition` that locks a collateral mint (e.g. USDC) and
//! issues two outcome SPL tokens, YES and NO, with the `Condition` PDA as their
//! mint authority. The complete-set invariant is:
//!
//! ```text
//!     1 collateral  <->  1 YES + 1 NO
//! ```
//!
//! Flow:
//! - `split`  : lock `amount` collateral -> mint `amount` YES and `amount` NO.
//! - `merge`  : burn `amount` YES + `amount` NO -> unlock `amount` collateral.
//! - `resolve`: the condition authority records the winning outcome.
//! - `redeem` : after resolution, burn `amount` of the winning token ->
//!              unlock `amount` collateral. The losing token becomes worthless.
//!
//! Outcome mints share the collateral mint's decimals, so amounts map 1:1 and
//! no scaling is required.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("HYryinXp2Vf8zM4ZuTuyuSvN5kmNRHparmU1MJ6Z8u9J");

pub const CONDITION_SEED: &[u8] = b"condition";
pub const YES_MINT_SEED: &[u8] = b"yes";
pub const NO_MINT_SEED: &[u8] = b"no";
pub const VAULT_SEED: &[u8] = b"vault";

pub const OUTCOME_YES: u8 = 0;
pub const OUTCOME_NO: u8 = 1;

#[program]
pub mod conditional_token {
    use super::*;

    /// Create a conditional token set for `market`: the YES/NO mints, the
    /// collateral vault, and the `Condition` record.
    pub fn initialize_condition(
        ctx: Context<InitializeCondition>,
        authority: Pubkey,
    ) -> Result<()> {
        let condition = &mut ctx.accounts.condition;
        condition.market = ctx.accounts.market.key();
        condition.authority = authority;
        condition.collateral_mint = ctx.accounts.collateral_mint.key();
        condition.yes_mint = ctx.accounts.yes_mint.key();
        condition.no_mint = ctx.accounts.no_mint.key();
        condition.vault = ctx.accounts.vault.key();
        condition.resolved = false;
        condition.winning_outcome = 0;
        condition.bump = ctx.bumps.condition;

        emit!(ConditionInitialized {
            condition: condition.key(),
            market: condition.market,
            collateral_mint: condition.collateral_mint,
            yes_mint: condition.yes_mint,
            no_mint: condition.no_mint,
        });
        Ok(())
    }

    /// Lock `amount` collateral and mint `amount` of both YES and NO to the user.
    pub fn split(ctx: Context<Split>, amount: u64) -> Result<()> {
        require!(amount > 0, ConditionError::InvalidAmount);

        // Pull collateral from the user into the vault.
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

        // Mint a complete set (YES + NO) to the user, signed by the condition PDA.
        let signer_seeds = ctx.accounts.condition.signer_seeds();
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.yes_mint.to_account_info(),
                    to: ctx.accounts.user_yes.to_account_info(),
                    authority: ctx.accounts.condition.to_account_info(),
                },
                &[&signer_seeds[..]],
            ),
            amount,
        )?;
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.no_mint.to_account_info(),
                    to: ctx.accounts.user_no.to_account_info(),
                    authority: ctx.accounts.condition.to_account_info(),
                },
                &[&signer_seeds[..]],
            ),
            amount,
        )?;

        emit!(SetSplit {
            condition: ctx.accounts.condition.key(),
            user: ctx.accounts.user.key(),
            amount,
        });
        Ok(())
    }

    /// Burn `amount` of both YES and NO and return `amount` collateral.
    pub fn merge(ctx: Context<Merge>, amount: u64) -> Result<()> {
        require!(amount > 0, ConditionError::InvalidAmount);

        // Burn the complete set held by the user.
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.yes_mint.to_account_info(),
                    from: ctx.accounts.user_yes.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.no_mint.to_account_info(),
                    from: ctx.accounts.user_no.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        // Release collateral from the vault back to the user.
        let signer_seeds = ctx.accounts.condition.signer_seeds();
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.user_collateral.to_account_info(),
                    authority: ctx.accounts.condition.to_account_info(),
                },
                &[&signer_seeds[..]],
            ),
            amount,
        )?;

        emit!(SetMerged {
            condition: ctx.accounts.condition.key(),
            user: ctx.accounts.user.key(),
            amount,
        });
        Ok(())
    }

    /// Record the winning outcome. Only the condition authority may call this.
    ///
    /// In production the authority is the market/oracle program, which calls
    /// this once `get_oracle_res` has decided the result.
    pub fn resolve(ctx: Context<Resolve>, winning_outcome: u8) -> Result<()> {
        require!(
            winning_outcome == OUTCOME_YES || winning_outcome == OUTCOME_NO,
            ConditionError::InvalidOutcome
        );
        let condition = &mut ctx.accounts.condition;
        require!(!condition.resolved, ConditionError::AlreadyResolved);
        condition.resolved = true;
        condition.winning_outcome = winning_outcome;

        emit!(ConditionResolved {
            condition: condition.key(),
            winning_outcome,
        });
        Ok(())
    }

    /// After resolution, burn `amount` of the winning token for `amount` collateral.
    pub fn redeem(ctx: Context<Redeem>, amount: u64) -> Result<()> {
        require!(amount > 0, ConditionError::InvalidAmount);
        let condition = &ctx.accounts.condition;
        require!(condition.resolved, ConditionError::NotResolved);

        // The supplied outcome mint must be the winning one.
        let expected_winner = if condition.winning_outcome == OUTCOME_YES {
            condition.yes_mint
        } else {
            condition.no_mint
        };
        require_keys_eq!(
            ctx.accounts.winning_mint.key(),
            expected_winner,
            ConditionError::NotWinningOutcome
        );

        // Burn the user's winning tokens.
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.winning_mint.to_account_info(),
                    from: ctx.accounts.user_winning.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        // Pay out collateral 1:1.
        let signer_seeds = condition.signer_seeds();
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.user_collateral.to_account_info(),
                    authority: ctx.accounts.condition.to_account_info(),
                },
                &[&signer_seeds[..]],
            ),
            amount,
        )?;

        emit!(Redeemed {
            condition: ctx.accounts.condition.key(),
            user: ctx.accounts.user.key(),
            amount,
        });
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Condition {
    /// The prediction market this condition is bound to (used as the PDA seed).
    pub market: Pubkey,
    /// Authority allowed to resolve the condition (market/oracle program or admin).
    pub authority: Pubkey,
    pub collateral_mint: Pubkey,
    pub yes_mint: Pubkey,
    pub no_mint: Pubkey,
    pub vault: Pubkey,
    pub resolved: bool,
    /// Valid only when `resolved`: 0 => YES, 1 => NO.
    pub winning_outcome: u8,
    pub bump: u8,
}

impl Condition {
    /// Signer seeds for the condition PDA (mint/transfer authority).
    fn signer_seeds(&self) -> [&[u8]; 3] {
        [CONDITION_SEED, self.market.as_ref(), std::slice::from_ref(&self.bump)]
    }
}

#[derive(Accounts)]
pub struct InitializeCondition<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: only used as the seed for the condition PDA.
    pub market: UncheckedAccount<'info>,

    pub collateral_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = payer,
        space = 8 + Condition::INIT_SPACE,
        seeds = [CONDITION_SEED, market.key().as_ref()],
        bump
    )]
    pub condition: Box<Account<'info, Condition>>,

    #[account(
        init,
        payer = payer,
        seeds = [YES_MINT_SEED, condition.key().as_ref()],
        bump,
        mint::decimals = collateral_mint.decimals,
        mint::authority = condition,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = payer,
        seeds = [NO_MINT_SEED, condition.key().as_ref()],
        bump,
        mint::decimals = collateral_mint.decimals,
        mint::authority = condition,
    )]
    pub no_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = payer,
        seeds = [VAULT_SEED, condition.key().as_ref()],
        bump,
        token::mint = collateral_mint,
        token::authority = condition,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Split<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    /// CHECK: only used as the seed for the condition PDA.
    pub market: UncheckedAccount<'info>,

    #[account(
        seeds = [CONDITION_SEED, market.key().as_ref()],
        bump = condition.bump,
        has_one = collateral_mint,
        has_one = yes_mint,
        has_one = no_mint,
        has_one = vault,
    )]
    pub condition: Box<Account<'info, Condition>>,

    pub collateral_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub yes_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub no_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = collateral_mint,
        associated_token::authority = user,
    )]
    pub user_collateral: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = yes_mint,
        associated_token::authority = user,
    )]
    pub user_yes: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = no_mint,
        associated_token::authority = user,
    )]
    pub user_no: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Merge<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    /// CHECK: only used as the seed for the condition PDA.
    pub market: UncheckedAccount<'info>,

    #[account(
        seeds = [CONDITION_SEED, market.key().as_ref()],
        bump = condition.bump,
        has_one = collateral_mint,
        has_one = yes_mint,
        has_one = no_mint,
        has_one = vault,
    )]
    pub condition: Box<Account<'info, Condition>>,

    pub collateral_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub yes_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub no_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = collateral_mint,
        associated_token::authority = user,
    )]
    pub user_collateral: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = yes_mint,
        associated_token::authority = user,
    )]
    pub user_yes: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = no_mint,
        associated_token::authority = user,
    )]
    pub user_no: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Resolve<'info> {
    #[account(constraint = authority.key() == condition.authority @ ConditionError::Unauthorized)]
    pub authority: Signer<'info>,

    /// CHECK: only used as the seed for the condition PDA.
    pub market: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [CONDITION_SEED, market.key().as_ref()],
        bump = condition.bump,
    )]
    pub condition: Box<Account<'info, Condition>>,
}

#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    /// CHECK: only used as the seed for the condition PDA.
    pub market: UncheckedAccount<'info>,

    #[account(
        seeds = [CONDITION_SEED, market.key().as_ref()],
        bump = condition.bump,
        has_one = collateral_mint,
        has_one = vault,
    )]
    pub condition: Box<Account<'info, Condition>>,

    pub collateral_mint: Box<Account<'info, Mint>>,
    #[account(mut)]
    pub vault: Box<Account<'info, TokenAccount>>,

    /// The winning outcome mint; validated against the condition in the handler.
    #[account(mut)]
    pub winning_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = winning_mint,
        associated_token::authority = user,
    )]
    pub user_winning: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = collateral_mint,
        associated_token::authority = user,
    )]
    pub user_collateral: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

#[event]
pub struct ConditionInitialized {
    pub condition: Pubkey,
    pub market: Pubkey,
    pub collateral_mint: Pubkey,
    pub yes_mint: Pubkey,
    pub no_mint: Pubkey,
}

#[event]
pub struct SetSplit {
    pub condition: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
}

#[event]
pub struct SetMerged {
    pub condition: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
}

#[event]
pub struct ConditionResolved {
    pub condition: Pubkey,
    pub winning_outcome: u8,
}

#[event]
pub struct Redeemed {
    pub condition: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum ConditionError {
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Invalid outcome (must be 0 = YES or 1 = NO)")]
    InvalidOutcome,
    #[msg("Condition is already resolved")]
    AlreadyResolved,
    #[msg("Condition is not resolved yet")]
    NotResolved,
    #[msg("Supplied mint is not the winning outcome")]
    NotWinningOutcome,
    #[msg("Unauthorized")]
    Unauthorized,
}
