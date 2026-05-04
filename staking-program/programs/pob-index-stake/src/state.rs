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

/// Hard ceiling for any per-position or per-pool early-unstake bps override.
/// Capped at 50% so a compromised authority cannot configure a 100%-penalty
/// rug. Anything above this in `set_position_early_unstake_bps` /
/// `set_pool_default_early_unstake_bps` is rejected at validation time.
pub const MAX_EARLY_UNSTAKE_BPS: u16 = 5_000; // 50.00%

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

/// Resolve the effective early-unstake bps for an unstake_early call.
/// Precedence: `position override > pool override > global EARLY_UNSTAKE_PENALTY_BPS`.
pub fn effective_early_unstake_bps(pool: &StakePool, position: &StakePosition) -> u32 {
    let pos_bps = read_position_override_bps(position);
    if pos_bps > 0 {
        return pos_bps as u32;
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
