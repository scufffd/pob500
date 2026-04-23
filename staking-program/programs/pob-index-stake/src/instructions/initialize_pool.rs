use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::state::*;

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub stake_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = authority,
        seeds = [StakePool::SEED, stake_mint.key().as_ref()],
        bump,
        space = StakePool::SIZE,
    )]
    pub pool: Account<'info, StakePool>,

    #[account(
        init,
        payer = authority,
        associated_token::mint = stake_mint,
        associated_token::authority = pool,
        associated_token::token_program = token_program,
    )]
    pub stake_vault: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<InitializePool>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    pool.bump = ctx.bumps.pool;
    pool.authority = ctx.accounts.authority.key();
    pool.stake_mint = ctx.accounts.stake_mint.key();
    pool.stake_vault = ctx.accounts.stake_vault.key();
    pool.total_staked = 0;
    pool.total_effective = 0;
    pool.reward_mint_count = 0;
    pool.created_at = Clock::get()?.unix_timestamp;
    pool.paused = false;
    pool.reserved = [0u8; 128];

    emit!(PoolInitialized {
        pool: pool.key(),
        authority: pool.authority,
        stake_mint: pool.stake_mint,
    });
    Ok(())
}

#[event]
pub struct PoolInitialized {
    pub pool: Pubkey,
    pub authority: Pubkey,
    pub stake_mint: Pubkey,
}
