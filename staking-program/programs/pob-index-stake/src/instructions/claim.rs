use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::errors::PobIndexStakeError;
use crate::state::*;

#[derive(Accounts)]
pub struct Claim<'info> {
    pub pool: Account<'info, StakePool>,

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
        has_one = owner,
    )]
    pub position: Account<'info, StakePosition>,

    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init_if_needed,
        payer = owner,
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
        constraint = user_token_account.owner == owner.key(),
    )]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<Claim>) -> Result<()> {
    let reward_mint = &mut ctx.accounts.reward_mint;
    let checkpoint = &mut ctx.accounts.checkpoint;
    let position = &ctx.accounts.position;

    // Baseline-safe (re)init: a fresh checkpoint — OR one inherited by a reused
    // position PDA (closed then re-staked under the same nonce) — snapshots the
    // CURRENT acc_per_share so the holder only ever accrues rewards deposited
    // AFTER this incarnation existed. Without the reuse branch, a re-staked
    // position would retroactively claim the entire `acc_per_share` growth that
    // happened while it did not exist (the over-claim that drove total_claimed
    // past total_deposited). See `state::checkpoint_needs_rebaseline`.
    let fresh = checkpoint.position == Pubkey::default();
    if checkpoint_needs_rebaseline(checkpoint, position) {
        checkpoint.bump = ctx.bumps.checkpoint;
        checkpoint.position = position.key();
        checkpoint.reward_mint = reward_mint.key();
        checkpoint.acc_per_share = reward_mint.acc_per_share;
        checkpoint.claimable = 0;
        if fresh {
            checkpoint.total_claimed = 0;
        }
    }
    // Stamp (or refresh) the position incarnation so any future PDA reuse is
    // detected. Migration-safe: legacy checkpoints keep their accrued balance
    // and are simply stamped here on first interaction.
    set_checkpoint_incarnation(checkpoint, position.lock_start);

    // Accrue using (pool_acc - ckpt_acc) * effective / 1e18
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

    // PRINCIPAL GUARD (commingled stake/reward vault).
    //
    // When the reward line being paid IS the stake mint, `reward_mint.vault`
    // is the SAME account as `pool.stake_vault`: it holds both staker principal
    // and the reward/penalty balance. A reward payout must never be funded from
    // that principal — doing so is exactly the drain vector that emptied the
    // pool (penalties bumped `acc_per_share`, then claim/claim_push paid those
    // "rewards" out of everyone else's stake). Only the surplus above
    // `pool.total_staked` is real, claimable reward liquidity.
    //
    // Separate (non-stake-mint) reward vaults hold no principal, so the guard is
    // a no-op for them and all normal SOL/USDC/token reward claims still pay in
    // full.
    if ctx.accounts.vault.key() == ctx.accounts.pool.stake_vault {
        let reward_liquidity = ctx
            .accounts
            .vault
            .amount
            .saturating_sub(ctx.accounts.pool.total_staked);
        require!(
            payout <= reward_liquidity,
            PobIndexStakeError::RewardWouldTouchPrincipal
        );
    }

    // Transfer from pool-owned vault to user. transfer_checked enforces decimals
    // and triggers any transfer hooks / fees on Token-2022 mints.
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

#[event]
pub struct Claimed {
    pub position: Pubkey,
    pub reward_mint: Pubkey,
    pub amount: u64,
}
