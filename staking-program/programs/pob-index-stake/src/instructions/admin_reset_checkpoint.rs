use anchor_lang::prelude::*;

use crate::errors::PobIndexStakeError;
use crate::state::*;

/// Authority-gated rewrite of an existing `RewardCheckpoint`'s
/// `acc_per_share` (and zeroing of `claimable` so it doesn't double-pay).
///
/// Why this exists: the on-chain `claim` handler runs a "baseline-safe init"
/// that snapshots a fresh checkpoint at the reward line's CURRENT
/// `acc_per_share`. That correctly prevents new stakers from retroactively
/// claiming historical rewards, but it becomes a foot-gun for stakers who
/// joined BEFORE a reward line was registered (or before anyone primed
/// their checkpoint) — the moment those stakers first call `claim`, their
/// checkpoint pins at the post-deposit value and they forfeit any
/// historical entitlement permanently.
///
/// Without this ix, the only fix would be to delete the checkpoint
/// (impossible — only the `close = owner` cascade in `unstake` can do
/// that, and it also closes the position), or to send tokens out-of-band
/// from a separate wallet. This lets the pool authority surgically reset
/// a single checkpoint to any baseline.
///
/// Designed to also support the future flow where `admin_reset_reward_mint`
/// wipes the reward line's accumulator state to zero, after which we'd
/// reset every existing checkpoint on that line to zero so that
/// `delta = rm.acc_per_share - ck.acc_per_share` doesn't underflow on the
/// next claim attempt.
#[derive(Accounts)]
pub struct AdminResetCheckpoint<'info> {
    #[account(
        has_one = authority @ PobIndexStakeError::NotAuthority,
    )]
    pub pool: Account<'info, StakePool>,

    pub authority: Signer<'info>,

    #[account(
        has_one = pool @ PobIndexStakeError::PoolMismatch,
    )]
    pub reward_mint: Account<'info, RewardMint>,

    #[account(
        has_one = pool @ PobIndexStakeError::PoolMismatch,
    )]
    pub position: Account<'info, StakePosition>,

    #[account(
        mut,
        seeds = [
            RewardCheckpoint::SEED,
            position.key().as_ref(),
            reward_mint.key().as_ref(),
        ],
        bump = checkpoint.bump,
        constraint = checkpoint.position == position.key() @ PobIndexStakeError::PoolMismatch,
        constraint = checkpoint.reward_mint == reward_mint.key() @ PobIndexStakeError::MintMismatch,
    )]
    pub checkpoint: Account<'info, RewardCheckpoint>,
}

pub fn handler(ctx: Context<AdminResetCheckpoint>, new_acc_per_share: u128) -> Result<()> {
    let cp = &mut ctx.accounts.checkpoint;
    let old_acc = cp.acc_per_share;
    let old_claimable = cp.claimable;
    cp.acc_per_share = new_acc_per_share;
    // Zero any booked-but-unclaimed balance — the typical use case for this
    // ix is "I'm wiping accumulator state, please don't double-pay any
    // previously accrued claimable".
    cp.claimable = 0;

    emit!(CheckpointAdminReset {
        position: ctx.accounts.position.key(),
        reward_mint: ctx.accounts.reward_mint.key(),
        old_acc_per_share: old_acc,
        new_acc_per_share,
        zeroed_claimable: old_claimable,
    });
    Ok(())
}

#[event]
pub struct CheckpointAdminReset {
    pub position: Pubkey,
    pub reward_mint: Pubkey,
    pub old_acc_per_share: u128,
    pub new_acc_per_share: u128,
    pub zeroed_claimable: u64,
}
