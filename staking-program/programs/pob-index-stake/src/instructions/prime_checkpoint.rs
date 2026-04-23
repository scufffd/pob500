use anchor_lang::prelude::*;

use crate::errors::PobIndexStakeError;
use crate::state::*;

/// Create a `RewardCheckpoint` for a (position, reward_mint) pair, snapshotting
/// the reward line's current `acc_per_share`. Used by the client immediately
/// after `stake` / `stake_for` (or whenever a new reward mint is registered) to
/// lock in the baseline — without this, the first `claim` on a fresh
/// checkpoint would retroactively include rewards deposited before the
/// checkpoint existed.
///
/// This instruction is **permissionless**: anyone can pay rent and call it for
/// any (position, reward_mint) pair. That is safe because it can only ever
/// snapshot the current `acc_per_share` — it cannot move funds, close
/// positions, or grant anyone any economic value. The permissionless form lets
/// the presale / treasury wallet pre-prime checkpoints for every contributor
/// so they accrue from the correct baseline without having to be online.
///
/// If the checkpoint already exists, this instruction is a no-op.
#[derive(Accounts)]
pub struct PrimeCheckpoint<'info> {
    pub pool: Account<'info, StakePool>,

    #[account(
        has_one = pool @ PobIndexStakeError::PoolMismatch,
    )]
    pub reward_mint: Account<'info, RewardMint>,

    #[account(
        has_one = pool @ PobIndexStakeError::PoolMismatch,
    )]
    pub position: Account<'info, StakePosition>,

    #[account(
        init_if_needed,
        payer = payer,
        seeds = [
            RewardCheckpoint::SEED,
            position.key().as_ref(),
            reward_mint.key().as_ref(),
        ],
        bump,
        space = RewardCheckpoint::SIZE,
    )]
    pub checkpoint: Account<'info, RewardCheckpoint>,

    /// Whoever pays rent for the checkpoint — may be the position owner, the
    /// treasury, or any third party. Checked as `mut` + `Signer` only to cover
    /// the rent lamports.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<PrimeCheckpoint>) -> Result<()> {
    let cp = &mut ctx.accounts.checkpoint;
    let position = &ctx.accounts.position;
    let reward_mint = &ctx.accounts.reward_mint;

    if cp.position == Pubkey::default() {
        cp.bump = ctx.bumps.checkpoint;
        cp.position = position.key();
        cp.reward_mint = reward_mint.key();
        cp.acc_per_share = reward_mint.acc_per_share;
        cp.claimable = 0;
        cp.total_claimed = 0;
        cp.reserved = [0u8; 16];

        emit!(CheckpointPrimed {
            position: position.key(),
            reward_mint: reward_mint.key(),
            acc_per_share: reward_mint.acc_per_share,
        });
    }

    Ok(())
}

#[event]
pub struct CheckpointPrimed {
    pub position: Pubkey,
    pub reward_mint: Pubkey,
    pub acc_per_share: u128,
}
