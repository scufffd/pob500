use anchor_lang::prelude::*;

/// MasterChef-style accumulator scale.
pub const ACC_PRECISION: u128 = 1_000_000_000_000_000_000; // 1e18

/// POB lock tiers (days → multiplier in basis points).
///
/// Short-cycle ladder tuned for weekly/monthly participation: 1d floor, 30d ceiling.
/// Longer lock → larger share of pool rewards. Old positions staked under the
/// previous (7/14/60/90/180) tiers remain valid — their multiplier is stored
/// on-chain per position, so this change only affects *new* stakes.
pub const LOCK_TIERS: [(u32, u32); 6] = [
    (1, 10_000),    // 1.00x
    (3, 12_500),    // 1.25x
    (7, 15_000),    // 1.50x
    (14, 20_000),   // 2.00x
    (21, 25_000),   // 2.50x
    (30, 30_000),   // 3.00x
];

pub fn multiplier_bps_for_days(days: u32) -> Option<u32> {
    for (d, bps) in LOCK_TIERS.iter() {
        if *d == days {
            return Some(*bps);
        }
    }
    None
}

/// Flat penalty applied to principal when a user unstakes before `lock_end`.
/// The penalty is redistributed to remaining stakers via the stake-mint reward
/// line; see `instructions/unstake_early.rs`. Rewards already accrued are
/// always claimable in full — the penalty only touches principal.
///
/// This is the **fallback** value used when neither the position nor the pool
/// has an override set. See `effective_early_unstake_bps`.
pub const EARLY_UNSTAKE_PENALTY_BPS: u32 = 1_000; // 10.00%

/// v5 dynamic early-unstake curve endpoints. New positions (flagged at stake
/// time) pay a penalty that decays **linearly** from `START` at `lock_start`
/// down to `END` at `lock_end`. The decay is continuous in time (effectively
/// per-second), so the same curve works for a 1-day lock and a 30-day lock —
/// unstaking on day 1 of a 30-day lock costs the full 50%, half-way through
/// costs 30%, and at expiry it's 10% (at which point `unstake` is free anyway).
///
/// Pre-v5 positions are NOT flagged and keep the flat `EARLY_UNSTAKE_PENALTY_BPS`
/// (10%) they were staked under — the curve only applies going forward.
pub const EARLY_UNSTAKE_START_BPS: u32 = 5_000; // 50.00% at lock_start
pub const EARLY_UNSTAKE_END_BPS: u32 = 1_000; //   10.00% at lock_end

/// Hard ceiling for any per-position or per-pool early-unstake bps override.
/// Capped at 90% — high enough to be a meaningful anti-dump deterrent for
/// KOL / presale allocations (a KOL up 1000% who unstakes early still walks
/// with ~110% gain at 90%), low enough that the position can never hit a
/// pure 100% rug. Anything above this in `set_position_early_unstake_bps` /
/// `set_pool_default_early_unstake_bps` is rejected at validation time.
pub const MAX_EARLY_UNSTAKE_BPS: u16 = 9_000; // 90.00%

/// Read the per-position early-unstake override bps from `position.reserved`.
/// Layout: bytes 0..2 = `u16` LE override. `0` means "no override".
pub fn read_position_override_bps(position: &StakePosition) -> u16 {
    u16::from_le_bytes([position.reserved[0], position.reserved[1]])
}

/// Write the per-position early-unstake override bps into `position.reserved`.
/// Caller is responsible for validating `bps <= MAX_EARLY_UNSTAKE_BPS`.
pub fn write_position_override_bps(position: &mut StakePosition, bps: u16) {
    let bytes = bps.to_le_bytes();
    position.reserved[0] = bytes[0];
    position.reserved[1] = bytes[1];
}

/// Read the v5 dynamic-decay flag from `position.reserved[2]`.
/// `1` = this position uses the linear time-decay early-unstake curve;
/// `0` = legacy flat behaviour (pre-v5 positions). Bytes `0..2` remain the
/// fixed-override `u16`, so the flag at byte `2` is independent of it.
pub fn read_position_dynamic_flag(position: &StakePosition) -> bool {
    position.reserved[2] == 1
}

/// Mark a position as using the v5 dynamic-decay early-unstake curve. Set once
/// at stake time on `stake` / `stake_for`; never cleared.
pub fn write_position_dynamic_flag(position: &mut StakePosition) {
    position.reserved[2] = 1;
}

/// Linearly decay the early-unstake penalty from `EARLY_UNSTAKE_START_BPS` at
/// `lock_start` down to `EARLY_UNSTAKE_END_BPS` at `lock_end`.
///
/// `bps = START - (START - END) * elapsed / duration`, clamped to `[END, START]`.
/// Guards against a zero/negative `duration` (returns `END`) and clamps a
/// pre-`lock_start` clock skew to `elapsed = 0` (returns `START`).
pub fn dynamic_early_unstake_bps(position: &StakePosition, now: i64) -> u32 {
    let start = EARLY_UNSTAKE_START_BPS as i128;
    let end = EARLY_UNSTAKE_END_BPS as i128;
    let duration = position.lock_end.saturating_sub(position.lock_start);
    if duration <= 0 {
        return EARLY_UNSTAKE_END_BPS;
    }
    let elapsed = now.saturating_sub(position.lock_start).max(0);
    if elapsed >= duration {
        return EARLY_UNSTAKE_END_BPS;
    }
    // START > END by construction, so `drop` is in [0, START-END] and the
    // result stays within [END, START] without an explicit clamp.
    let drop = (start - end)
        .saturating_mul(elapsed as i128)
        .saturating_div(duration as i128);
    (start - drop) as u32
}

/// Read the per-pool default early-unstake override bps from `pool.reserved`.
/// Layout: bytes 0..2 = `u16` LE override. `0` means "no override".
pub fn read_pool_override_bps(pool: &StakePool) -> u16 {
    u16::from_le_bytes([pool.reserved[0], pool.reserved[1]])
}

/// Write the per-pool default early-unstake override bps into `pool.reserved`.
pub fn write_pool_override_bps(pool: &mut StakePool, bps: u16) {
    let bytes = bps.to_le_bytes();
    pool.reserved[0] = bytes[0];
    pool.reserved[1] = bytes[1];
}

/// Resolve the effective early-unstake bps for an unstake_early call at time
/// `now` (unix seconds).
///
/// Precedence:
///   1. Per-position fixed override (`set_position_early_unstake_bps`) — these
///      are intentional anti-dump locks (KOL / presale) and must NOT decay.
///   2. v5 dynamic-decay flag — linear 50% → 10% over `[lock_start, lock_end]`.
///   3. Per-pool fixed override (legacy).
///   4. Global flat `EARLY_UNSTAKE_PENALTY_BPS` (10%) — pre-v5 positions, which
///      keep the flat terms they were staked under.
pub fn effective_early_unstake_bps(pool: &StakePool, position: &StakePosition, now: i64) -> u32 {
    let pos_bps = read_position_override_bps(position);
    if pos_bps > 0 {
        return pos_bps as u32;
    }
    if read_position_dynamic_flag(position) {
        return dynamic_early_unstake_bps(position, now);
    }
    let pool_bps = read_pool_override_bps(pool);
    if pool_bps > 0 {
        return pool_bps as u32;
    }
    EARLY_UNSTAKE_PENALTY_BPS
}

/// Compute the penalty amount and the net refund for an early unstake using
/// the effective bps. Returns `(penalty, refund)` where
/// `penalty + refund == amount` (modulo integer rounding-down on penalty).
pub fn compute_early_unstake_penalty_bps(amount: u64, bps: u32) -> (u64, u64) {
    let penalty = (amount as u128)
        .saturating_mul(bps as u128)
        / 10_000u128;
    let penalty = penalty as u64;
    let refund = amount.saturating_sub(penalty);
    (penalty, refund)
}

/// Backward-compatible wrapper using the global default bps. Retained for
/// callers that pre-date the per-position override (none currently in-tree
/// after v4 — kept for safety in case any downstream code still imports it).
pub fn compute_early_unstake_penalty(amount: u64) -> (u64, u64) {
    compute_early_unstake_penalty_bps(amount, EARLY_UNSTAKE_PENALTY_BPS)
}

#[account]
pub struct StakePool {
    pub bump: u8,
    pub authority: Pubkey,
    pub stake_mint: Pubkey,
    pub stake_vault: Pubkey,
    pub total_staked: u64,
    pub total_effective: u128,
    pub reward_mint_count: u32,
    pub created_at: i64,
    pub paused: bool,
    pub reserved: [u8; 128],
}

impl StakePool {
    pub const SEED: &'static [u8] = b"pool";
    pub const SIZE: usize = 8   // discriminator
        + 1                      // bump
        + 32                     // authority
        + 32                     // stake_mint
        + 32                     // stake_vault
        + 8                      // total_staked
        + 16                     // total_effective (u128)
        + 4                      // reward_mint_count
        + 8                      // created_at
        + 1                      // paused
        + 128;                   // reserved
}

#[account]
pub struct RewardMint {
    pub bump: u8,
    pub pool: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub acc_per_share: u128,
    pub last_deposit_ts: i64,
    pub total_deposited: u64,
    pub total_claimed: u64,
    pub reserved: [u8; 64],
}

impl RewardMint {
    pub const SEED: &'static [u8] = b"reward";
    pub const SIZE: usize = 8
        + 1                      // bump
        + 32                     // pool
        + 32                     // mint
        + 32                     // vault
        + 16                     // acc_per_share (u128)
        + 8                      // last_deposit_ts
        + 8                      // total_deposited
        + 8                      // total_claimed
        + 64;                    // reserved
}

#[account]
pub struct StakePosition {
    pub bump: u8,
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub multiplier_bps: u32,
    pub effective: u128,
    pub lock_days: u32,
    pub lock_start: i64,
    pub lock_end: i64,
    pub closed: bool,
    pub reserved: [u8; 32],
}

impl StakePosition {
    pub const SEED: &'static [u8] = b"position";
    pub const SIZE: usize = 8
        + 1                      // bump
        + 32                     // pool
        + 32                     // owner
        + 8                      // amount
        + 4                      // multiplier_bps
        + 16                     // effective
        + 4                      // lock_days
        + 8                      // lock_start
        + 8                      // lock_end
        + 1                      // closed
        + 32;                    // reserved
}

/// Per (position, reward_mint) accrual checkpoint so each position can claim
/// each reward independently.
#[account]
pub struct RewardCheckpoint {
    pub bump: u8,
    pub position: Pubkey,
    pub reward_mint: Pubkey,
    pub acc_per_share: u128,
    pub claimable: u64,
    pub total_claimed: u64,
    pub reserved: [u8; 16],
}

impl RewardCheckpoint {
    pub const SEED: &'static [u8] = b"checkpoint";
    pub const SIZE: usize = 8
        + 1                      // bump
        + 32                     // position
        + 32                     // reward_mint
        + 16                     // acc_per_share
        + 8                      // claimable
        + 8                      // total_claimed
        + 16;                    // reserved
}

/// Marker flag stored in `RewardCheckpoint.reserved[0]`. When set, bytes
/// `reserved[1..9]` hold the `position.lock_start` (LE i64) of the *exact
/// position incarnation* this checkpoint was baselined against.
///
/// ## Why this exists — the position-PDA-reuse vector
/// A `StakePosition` PDA is derived from `[b"position", pool, owner, nonce]`.
/// When a position is closed (`unstake` / `unstake_early` carry
/// `close = owner`), the position account is reclaimed — but its
/// `RewardCheckpoint` PDAs are NOT (they aren't passed to those instructions,
/// so Anchor cannot close them; the old doc comments claiming a "cascade
/// close" were wrong). The owner can then re-`stake` with the SAME nonce,
/// re-`init`-ing the identical position PDA. The leftover checkpoint still
/// carries the OLD (lower) `acc_per_share`, so the next `claim` would accrue
/// `(current_acc - stale_acc) * effective` — rewards for the entire window
/// the position did not exist. This is the over-claim that pushed
/// `total_claimed` above `total_deposited`.
///
/// The fix: stamp the incarnation (its `lock_start`) into the checkpoint and,
/// on every claim, re-baseline the checkpoint whenever the stamped incarnation
/// no longer matches the live position (i.e. the PDA was reused). Stamping is
/// migration-safe: legacy checkpoints (flag == 0) keep their accrued balance
/// and simply get stamped on first interaction, after which any future reuse
/// is caught.
pub const CKPT_MARKER_FLAG: u8 = 1;

/// Read the stamped position incarnation (`lock_start`) from a checkpoint, or
/// `None` if it predates the marker (legacy).
pub fn checkpoint_incarnation(cp: &RewardCheckpoint) -> Option<i64> {
    if cp.reserved[0] == CKPT_MARKER_FLAG {
        let mut buf = [0u8; 8];
        buf.copy_from_slice(&cp.reserved[1..9]);
        Some(i64::from_le_bytes(buf))
    } else {
        None
    }
}

/// Stamp the position incarnation (`lock_start`) onto a checkpoint.
pub fn set_checkpoint_incarnation(cp: &mut RewardCheckpoint, lock_start: i64) {
    cp.reserved[0] = CKPT_MARKER_FLAG;
    cp.reserved[1..9].copy_from_slice(&lock_start.to_le_bytes());
}

/// Decide whether a checkpoint must be (re)baselined before accruing, given
/// the live position it is being claimed against. Returns true when:
///   - the checkpoint is freshly created (`position == default`), or
///   - the checkpoint was stamped for a DIFFERENT incarnation than the live
///     position (the PDA was closed and re-staked → stale baseline).
///
/// A legacy (un-stamped) checkpoint returns false here so its genuinely
/// accrued balance is preserved; it is stamped on this same interaction so
/// any subsequent reuse is detected.
pub fn checkpoint_needs_rebaseline(cp: &RewardCheckpoint, position: &StakePosition) -> bool {
    if cp.position == Pubkey::default() {
        return true;
    }
    match checkpoint_incarnation(cp) {
        Some(stamped) => stamped != position.lock_start,
        None => false,
    }
}
