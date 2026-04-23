use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::errors::PobIndexStakeError;
use crate::state::*;

#[derive(Accounts)]
pub struct AddRewardMint<'info> {
    #[account(
        mut,
        has_one = authority @ PobIndexStakeError::NotAuthority,
    )]
    pub pool: Account<'info, StakePool>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub reward_token_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = authority,
        seeds = [RewardMint::SEED, pool.key().as_ref(), reward_token_mint.key().as_ref()],
        bump,
        space = RewardMint::SIZE,
    )]
    pub reward_mint: Account<'info, RewardMint>,

    // `init_if_needed` lets admins register the stake mint itself as a reward
    // line: the ATA (stake_mint, pool) already exists as the principal
    // `stake_vault`, and it's correct for that same ATA to back the stake-mint
    // reward line too. The MasterChef-style `acc_per_share` accounting keeps
    // principal and redistributed penalty tokens separable even when they share
    // a vault (see unstake_early.rs). For other reward mints, this just
    // creates a fresh pool-owned ATA as before.
    #[account(
        init_if_needed,
        payer = authority,
        associated_token::mint = reward_token_mint,
        associated_token::authority = pool,
        associated_token::token_program = token_program,
    )]
    pub reward_vault: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<AddRewardMint>) -> Result<()> {
    let reward_mint = &mut ctx.accounts.reward_mint;
    reward_mint.bump = ctx.bumps.reward_mint;
    reward_mint.pool = ctx.accounts.pool.key();
    reward_mint.mint = ctx.accounts.reward_token_mint.key();
    reward_mint.vault = ctx.accounts.reward_vault.key();
    reward_mint.acc_per_share = 0;
    reward_mint.last_deposit_ts = Clock::get()?.unix_timestamp;
    reward_mint.total_deposited = 0;
    reward_mint.total_claimed = 0;
    reward_mint.reserved = [0u8; 64];

    let pool = &mut ctx.accounts.pool;
    pool.reward_mint_count = pool
        .reward_mint_count
        .checked_add(1)
        .ok_or(PobIndexStakeError::Overflow)?;
    Ok(())
}
