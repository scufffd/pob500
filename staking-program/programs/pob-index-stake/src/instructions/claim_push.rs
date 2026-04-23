use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::errors::PobIndexStakeError;
use crate::state::*;

use super::claim::Claimed;

/// Same accounting as [`claim`](crate::instructions::claim), but **`pool.authority`**
/// signs instead of the staker. Tokens are always sent to `position.owner`'s ATA
/// (`user_token_account` must be owned by that pubkey). The authority also pays
/// rent when a `RewardCheckpoint` is created for the first time.
///
/// This lets an off-chain worker batch-settle rewards each cycle so holders do
/// not need to manually claim — without changing the underlying MasterChef math
/// or letting anyone redirect payouts (recipient is enforced on-chain).
#[derive(Accounts)]
pub struct ClaimPush<'info> {
    #[account(
        mut,
        has_one = authority @ PobIndexStakeError::NotAuthority,
    )]
    pub pool: Account<'info, StakePool>,

    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = pool @ PobIndexStakeError::PoolMismatch,
    )]
    pub reward_mint: Account<'info, RewardMint>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = vault.key() == reward_mint.vault @ PobIndexStakeError::MintMismatch,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        has_one = pool @ PobIndexStakeError::PoolMismatch,
        constraint = !position.closed @ PobIndexStakeError::PositionClosed,
    )]
    pub position: Account<'info, StakePosition>,

    #[account(
        init_if_needed,
        payer = authority,
        seeds = [
            RewardCheckpoint::SEED,
            position.key().as_ref(),
            reward_mint.key().as_ref(),
        ],
        bump,
        space = RewardCheckpoint::SIZE,
    )]
    pub checkpoint: Account<'info, RewardCheckpoint>,

    #[account(
        mut,
        constraint = user_token_account.mint == mint.key() @ PobIndexStakeError::MintMismatch,
        constraint = user_token_account.owner == position.owner @ PobIndexStakeError::WrongRewardRecipient,
    )]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<ClaimPush>) -> Result<()> {
    let reward_mint = &mut ctx.accounts.reward_mint;
    let checkpoint = &mut ctx.accounts.checkpoint;
    let position = &ctx.accounts.position;

    if checkpoint.position == Pubkey::default() {
        checkpoint.bump = ctx.bumps.checkpoint;
        checkpoint.position = position.key();
        checkpoint.reward_mint = reward_mint.key();
        checkpoint.acc_per_share = reward_mint.acc_per_share;
        checkpoint.claimable = 0;
        checkpoint.total_claimed = 0;
        checkpoint.reserved = [0u8; 16];
    }

    let delta = reward_mint
        .acc_per_share
        .checked_sub(checkpoint.acc_per_share)
        .ok_or(PobIndexStakeError::Overflow)?;
    let accrued_128 = delta
        .checked_mul(position.effective)
        .and_then(|v| v.checked_div(ACC_PRECISION))
        .ok_or(PobIndexStakeError::Overflow)?;
    let accrued: u64 = accrued_128.try_into().map_err(|_| PobIndexStakeError::Overflow)?;

    checkpoint.claimable = checkpoint
        .claimable
        .checked_add(accrued)
        .ok_or(PobIndexStakeError::Overflow)?;
    checkpoint.acc_per_share = reward_mint.acc_per_share;

    let payout = checkpoint.claimable;
    if payout == 0 {
        emit!(Claimed {
            position: position.key(),
            reward_mint: reward_mint.key(),
            amount: 0,
        });
        return Ok(());
    }

    let stake_mint_key = ctx.accounts.pool.stake_mint;
    let pool_bump = ctx.accounts.pool.bump;
    let seeds = &[StakePool::SEED, stake_mint_key.as_ref(), &[pool_bump]];
    let signer = &[&seeds[..]];
    let decimals = ctx.accounts.mint.decimals;
    let cpi = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        TransferChecked {
            from: ctx.accounts.vault.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.pool.to_account_info(),
        },
        signer,
    );
    token_interface::transfer_checked(cpi, payout, decimals)?;

    checkpoint.claimable = 0;
    checkpoint.total_claimed = checkpoint
        .total_claimed
        .checked_add(payout)
        .ok_or(PobIndexStakeError::Overflow)?;
    reward_mint.total_claimed = reward_mint
        .total_claimed
        .checked_add(payout)
        .ok_or(PobIndexStakeError::Overflow)?;

    emit!(Claimed {
        position: position.key(),
        reward_mint: reward_mint.key(),
        amount: payout,
    });
    Ok(())
}
