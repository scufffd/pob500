use anchor_lang::prelude::*;

use crate::errors::PobIndexStakeError;
use crate::state::*;

/// Authority-gated setter for `pool.paused`. The flag has been read by
/// `stake.rs` and `stake_for.rs` since v1, but until this ix existed there
/// was no way to flip it — it was always `false`. With pause enabled, new
/// `stake` / `stake_for` calls bail with `Paused`, but `claim`, `unstake`,
/// and `unstake_early` continue to work so funds are never trapped.
///
/// Used by the SQWARK remediation runbook to freeze new stakes while we
/// `sweep_reward_vault` + `admin_reset_*` the broken stake-mint reward line.
#[derive(Accounts)]
pub struct SetPaused<'info> {
    #[account(
        mut,
        has_one = authority @ PobIndexStakeError::NotAuthority,
    )]
    pub pool: Account<'info, StakePool>,

    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let old = pool.paused;
    pool.paused = paused;
    emit!(PoolPauseChanged {
        pool: pool.key(),
        old_paused: old,
        new_paused: paused,
    });
    Ok(())
}

#[event]
pub struct PoolPauseChanged {
    pub pool: Pubkey,
    pub old_paused: bool,
    pub new_paused: bool,
}
