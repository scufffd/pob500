use anchor_lang::prelude::*;

use crate::errors::PobIndexStakeError;
use crate::state::*;

/// Authority-gated rewrite of a reward line's accumulator state. Lets the
/// authority "wipe the slate clean" on a reward mint after a vault sweep
/// or other irrecoverable accounting drift.
///
/// Typical sequence (the SQWARK remediation runbook):
///   1. `set_paused(true)` — freeze new stakes
///   2. `sweep_reward_vault(amount=0)` — drain the vault to backup treasury
///   3. `admin_reset_reward_mint(0, 0, 0)` — zero the accumulator + ledger
///   4. `admin_reset_checkpoint(position, reward_mint, 0)` — for each
///      position whose checkpoint was already pinned at the old non-zero
///      `acc_per_share` (without this, that staker's next `claim` would
///      compute `delta = 0 - old_acc` and underflow)
///   5. `prime_checkpoint(position, reward_mint)` — for each position
///      that has no checkpoint yet (baselines them at the new `0`)
///   6. `set_paused(false)` — resume
///
/// After this, the reward line behaves as if newly-registered: future
/// `deposit_rewards` / `unstake_early` (which bumps the stake-mint reward's
/// `acc_per_share` proportionally to the penalty) will accrue normally to
/// every active position.
#[derive(Accounts)]
pub struct AdminResetRewardMint<'info> {
    #[account(
        has_one = authority @ PobIndexStakeError::NotAuthority,
    )]
    pub pool: Account<'info, StakePool>,

    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = pool @ PobIndexStakeError::PoolMismatch,
    )]
    pub reward_mint: Account<'info, RewardMint>,
}

pub fn handler(
    ctx: Context<AdminResetRewardMint>,
    new_acc_per_share: u128,
    new_total_deposited: u64,
    new_total_claimed: u64,
) -> Result<()> {
    let rm = &mut ctx.accounts.reward_mint;
    let old_acc = rm.acc_per_share;
    let old_dep = rm.total_deposited;
    let old_clm = rm.total_claimed;

    rm.acc_per_share = new_acc_per_share;
    rm.total_deposited = new_total_deposited;
    rm.total_claimed = new_total_claimed;
    rm.last_deposit_ts = Clock::get()?.unix_timestamp;

    emit!(RewardMintAdminReset {
        pool: ctx.accounts.pool.key(),
        reward_mint: rm.key(),
        old_acc_per_share: old_acc,
        new_acc_per_share,
        old_total_deposited: old_dep,
        new_total_deposited,
        old_total_claimed: old_clm,
        new_total_claimed,
    });
    Ok(())
}

#[event]
pub struct RewardMintAdminReset {
    pub pool: Pubkey,
    pub reward_mint: Pubkey,
    pub old_acc_per_share: u128,
    pub new_acc_per_share: u128,
    pub old_total_deposited: u64,
    pub new_total_deposited: u64,
    pub old_total_claimed: u64,
    pub new_total_claimed: u64,
}
