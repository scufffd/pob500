use anchor_lang::prelude::*;

use crate::errors::PobIndexStakeError;
use crate::state::*;

/// Authority-gated setter for a per-position early-unstake penalty override.
///
/// ## Why
/// `unstake_early` historically applied a fixed 10% penalty
/// (`EARLY_UNSTAKE_PENALTY_BPS`). With the v4 expansion we want different
/// penalty curves for different *attribution categories* on a given pool:
///
///   - **Presale auto-staked positions** — softer (e.g. 5%): the user paid
///     SOL for these tokens, locking them is a courtesy, not a moat.
///   - **KOL airdrop positions** — harder (e.g. 30%): tokens were free and
///     the lock is the only thing keeping a recipient from dump-and-running.
///   - **Organic self-stakes** — keeps the global default (10%) unless the
///     pool authority sets a per-pool default via `pool.reserved`.
///
/// Rather than re-deploying the program every time the platform tunes these
/// numbers, the authority writes the bps directly onto the position when it
/// is opened (typically bundled with `stake_for` in the same transaction so
/// the override is atomic with the stake itself).
///
/// ## Storage
/// The override is packed into `position.reserved[0..2]` as a little-endian
/// `u16`. Bytes 2..32 are still untouched and reserved for future fields.
/// Existing positions (created before v4) have all-zero reserved bytes,
/// which `effective_early_unstake_bps` reads as "no override → fall through
/// to pool default → fall through to the global 10% constant" — i.e. a
/// transparent no-op for legacy positions.
///
/// ## Authority model
/// Only `pool.authority` may mutate the override. The position owner
/// **cannot** lower their own penalty unilaterally — that protects remaining
/// stakers (whose redistributed-penalty rewards depend on the value the
/// platform set at stake time).
///
/// ## Safety cap
/// The bps is capped at `MAX_EARLY_UNSTAKE_BPS` (9_000 = 90%) at the program
/// level so a compromised authority cannot configure a 100%-penalty rug.
/// 90% is high enough to be a meaningful anti-dump deterrent on free KOL
/// allocations (a KOL up 1000% who exits early still walks with ~110%
/// gain) while keeping the structural "you always get *something* back"
/// guarantee. `bps == 0` is allowed and means "clear the override / revert
/// to pool default" — useful for one-off reverts without re-staking.
///
/// ## What this does NOT touch
/// - `position.amount`, `effective`, `lock_*`, `closed`, `multiplier_bps` —
///   all preserved bit-for-bit.
/// - Pool totals (`total_staked`, `total_effective`).
/// - Any reward-line accumulator (`acc_per_share`).
/// - Any RewardCheckpoint balance.
///
/// In short: pure metadata write, no value-bearing state moves.
#[derive(Accounts)]
pub struct SetPositionEarlyUnstakeBps<'info> {
    #[account(
        has_one = authority @ PobIndexStakeError::NotAuthority,
    )]
    pub pool: Account<'info, StakePool>,

    /// The position whose override is being mutated. Must belong to `pool`.
    /// Re-asserts non-closed because a closed position is rent-reclaimed; we
    /// don't want to dirty-write to a soon-to-be-zero account.
    #[account(
        mut,
        has_one = pool @ PobIndexStakeError::PoolMismatch,
        constraint = !position.closed @ PobIndexStakeError::PositionAlreadyClosed,
    )]
    pub position: Account<'info, StakePosition>,

    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<SetPositionEarlyUnstakeBps>, bps: u16) -> Result<()> {
    require!(
        bps <= MAX_EARLY_UNSTAKE_BPS,
        PobIndexStakeError::EarlyUnstakeBpsTooHigh,
    );

    let position = &mut ctx.accounts.position;
    let old = read_position_override_bps(position);
    write_position_override_bps(position, bps);

    emit!(PositionEarlyUnstakeBpsChanged {
        position: position.key(),
        pool: ctx.accounts.pool.key(),
        old_bps: old,
        new_bps: bps,
    });

    Ok(())
}

#[event]
pub struct PositionEarlyUnstakeBpsChanged {
    pub position: Pubkey,
    pub pool: Pubkey,
    pub old_bps: u16,
    pub new_bps: u16,
}
