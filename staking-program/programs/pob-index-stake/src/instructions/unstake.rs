use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::errors::PobIndexStakeError;
use crate::state::*;

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(
        mut,
        has_one = stake_mint @ PobIndexStakeError::MintMismatch,
        has_one = stake_vault @ PobIndexStakeError::PoolMismatch,
    )]
    pub pool: Account<'info, StakePool>,

    pub stake_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub stake_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        has_one = pool @ PobIndexStakeError::PoolMismatch,
        has_one = owner,
        close = owner,
    )]
    pub position: Account<'info, StakePosition>,

    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        constraint = user_token_account.mint == stake_mint.key() @ PobIndexStakeError::MintMismatch,
        constraint = user_token_account.owner == owner.key(),
    )]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<Unstake>) -> Result<()> {
    let position = &mut ctx.accounts.position;
    require!(!position.closed, PobIndexStakeError::PositionClosed);

    let now = Clock::get()?.unix_timestamp;
    require!(now >= position.lock_end, PobIndexStakeError::LockNotExpired);

    let amount = position.amount;
    let effective = position.effective;

    // Transfer staked tokens back to the owner using pool PDA as signer.
    let stake_mint_key = ctx.accounts.pool.stake_mint;
    let pool_bump = ctx.accounts.pool.bump;
    let seeds = &[StakePool::SEED, stake_mint_key.as_ref(), &[pool_bump]];
    let signer = &[&seeds[..]];
    let decimals = ctx.accounts.stake_mint.decimals;
    let cpi = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        TransferChecked {
            from: ctx.accounts.stake_vault.to_account_info(),
            mint: ctx.accounts.stake_mint.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.pool.to_account_info(),
        },
        signer,
    );
    token_interface::transfer_checked(cpi, amount, decimals)?;

    let pool = &mut ctx.accounts.pool;
    pool.total_staked = pool
        .total_staked
        .checked_sub(amount)
        .ok_or(PobIndexStakeError::Overflow)?;
    pool.total_effective = pool
        .total_effective
        .checked_sub(effective)
        .ok_or(PobIndexStakeError::Overflow)?;

    position.closed = true;

    emit!(Unstaked {
        position: position.key(),
        owner: position.owner,
        amount,
    });
    Ok(())
}

#[event]
pub struct Unstaked {
    pub position: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
}
