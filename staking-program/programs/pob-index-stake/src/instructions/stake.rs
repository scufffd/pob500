use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::errors::PobIndexStakeError;
use crate::state::*;

#[derive(Accounts)]
#[instruction(amount: u64, lock_days: u32, nonce: u64)]
pub struct Stake<'info> {
    #[account(
        mut,
        has_one = stake_mint @ PobIndexStakeError::MintMismatch,
        has_one = stake_vault @ PobIndexStakeError::PoolMismatch,
    )]
    pub pool: Account<'info, StakePool>,

    pub stake_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub stake_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        constraint = user_token_account.mint == stake_mint.key() @ PobIndexStakeError::MintMismatch,
        constraint = user_token_account.owner == owner.key(),
    )]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init,
        payer = owner,
        seeds = [
            StakePosition::SEED,
            pool.key().as_ref(),
            owner.key().as_ref(),
            &nonce.to_le_bytes(),
        ],
        bump,
        space = StakePosition::SIZE,
    )]
    pub position: Account<'info, StakePosition>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<Stake>, amount: u64, lock_days: u32, _nonce: u64) -> Result<()> {
    require!(!ctx.accounts.pool.paused, PobIndexStakeError::Paused);
    require!(amount > 0, PobIndexStakeError::ZeroAmount);

    let multiplier_bps =
        multiplier_bps_for_days(lock_days).ok_or(PobIndexStakeError::InvalidLockTier)?;

    let now = Clock::get()?.unix_timestamp;
    let lock_end = now
        .checked_add((lock_days as i64).checked_mul(86_400).ok_or(PobIndexStakeError::Overflow)?)
        .ok_or(PobIndexStakeError::Overflow)?;

    let effective = (amount as u128)
        .checked_mul(multiplier_bps as u128)
        .and_then(|v| v.checked_div(10_000))
        .ok_or(PobIndexStakeError::Overflow)?;

    // Transfer tokens from user into pool vault using transfer_checked so any
    // transfer hooks / fee extensions on the mint are enforced.
    let decimals = ctx.accounts.stake_mint.decimals;
    let cpi = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        TransferChecked {
            from: ctx.accounts.user_token_account.to_account_info(),
            mint: ctx.accounts.stake_mint.to_account_info(),
            to: ctx.accounts.stake_vault.to_account_info(),
            authority: ctx.accounts.owner.to_account_info(),
        },
    );
    token_interface::transfer_checked(cpi, amount, decimals)?;

    let position = &mut ctx.accounts.position;
    position.bump = ctx.bumps.position;
    position.pool = ctx.accounts.pool.key();
    position.owner = ctx.accounts.owner.key();
    position.amount = amount;
    position.multiplier_bps = multiplier_bps;
    position.effective = effective;
    position.lock_days = lock_days;
    position.lock_start = now;
    position.lock_end = lock_end;
    position.closed = false;
    position.reserved = [0u8; 32];

    let pool = &mut ctx.accounts.pool;
    pool.total_staked = pool
        .total_staked
        .checked_add(amount)
        .ok_or(PobIndexStakeError::Overflow)?;
    pool.total_effective = pool
        .total_effective
        .checked_add(effective)
        .ok_or(PobIndexStakeError::Overflow)?;

    emit!(Staked {
        position: position.key(),
        owner: position.owner,
        amount,
        multiplier_bps,
        effective,
        lock_end,
    });
    Ok(())
}

#[event]
pub struct Staked {
    pub position: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub multiplier_bps: u32,
    pub effective: u128,
    pub lock_end: i64,
}
