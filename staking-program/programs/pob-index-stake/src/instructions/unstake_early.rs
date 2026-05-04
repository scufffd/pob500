use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::errors::PobIndexStakeError;
use crate::state::*;

/// Early-unstake: exit a position BEFORE `lock_end`. Pays a penalty on the
/// staked principal whose bps is resolved at call time as:
///   `position override (reserved[0..2]) > pool override (reserved[0..2]) > EARLY_UNSTAKE_PENALTY_BPS (10%)`
/// — see `state::effective_early_unstake_bps`. Capped at 50% by the setter.
///
/// ## Mechanics
/// The refund (amount − penalty) is transferred from `stake_vault` back to the
/// user. The penalty **stays in `stake_vault`** and the stake-mint reward
/// line's `acc_per_share` is bumped against the new pool total so remaining
/// stakers accrue the penalty pro-rata to their effective stake.
///
/// ## Shared-vault invariant
/// The stake mint's reward vault IS `stake_vault` — the same ATA also escrows
/// principal. This is safe because the MasterChef-style accounting keeps
/// principal (tracked via `pool.total_staked`) and redistributed penalty
/// (tracked via `stake_reward_mint.total_deposited / total_claimed`) on
/// separate ledgers. At any time:
///     vault_balance == pool.total_staked
///                     + (stake_reward_mint.total_deposited
///                        - stake_reward_mint.total_claimed)
///
/// ## Rewards
/// Accrued rewards are NOT affected — the caller should claim them before or
/// atomically with this ix (the SDK bundles both into a single transaction).
/// Closing the position wipes its checkpoints; any unclaimed accrued balance
/// is forfeit.
///
/// ## Prerequisite
/// The admin must have registered the stake mint as a reward mint via
/// `add_reward_mint(stake_mint)` before any user can call this. `add_reward_mint`
/// uses `init_if_needed` on the vault so it happily aliases `stake_vault`.
#[derive(Accounts)]
pub struct UnstakeEarly<'info> {
    #[account(
        mut,
        has_one = stake_mint @ PobIndexStakeError::MintMismatch,
        has_one = stake_vault @ PobIndexStakeError::PoolMismatch,
    )]
    pub pool: Account<'info, StakePool>,

    pub stake_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub stake_vault: InterfaceAccount<'info, TokenAccount>,

    /// The reward-mint record for the stake mint itself. Penalty redistributes
    /// through this line so remaining stakers earn more of our native token.
    /// Its `.vault` must equal `stake_vault` (enforced by constraint) so the
    /// shared-vault invariant holds.
    #[account(
        mut,
        constraint = stake_reward_mint.pool == pool.key() @ PobIndexStakeError::PoolMismatch,
        constraint = stake_reward_mint.mint == stake_mint.key() @ PobIndexStakeError::StakeMintRewardNotRegistered,
        constraint = stake_reward_mint.vault == stake_vault.key() @ PobIndexStakeError::MintMismatch,
    )]
    pub stake_reward_mint: Account<'info, RewardMint>,

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

pub fn handler(ctx: Context<UnstakeEarly>) -> Result<()> {
    let position = &mut ctx.accounts.position;
    require!(!position.closed, PobIndexStakeError::PositionClosed);

    let now = Clock::get()?.unix_timestamp;
    require!(
        now < position.lock_end,
        PobIndexStakeError::LockAlreadyExpired,
    );

    let amount = position.amount;
    let effective = position.effective;
    // v4: bps is per-position-overrideable (set via set_position_early_unstake_bps).
    // Falls back to pool override, then to the 10% global default. See
    // state::effective_early_unstake_bps. `&*position` re-borrows the
    // outstanding `&mut Account<...>` as a `&Account<...>` so the helper can
    // deref-coerce to `&StakePosition` without conflicting with the mut
    // borrow we still need below for closing the position.
    let bps = effective_early_unstake_bps(&ctx.accounts.pool, &*position);
    let (penalty, refund) = compute_early_unstake_penalty_bps(amount, bps);
    require!(refund > 0, PobIndexStakeError::ZeroAmount);

    // Pre-compute signer seeds so both CPIs below can reuse them.
    let stake_mint_key = ctx.accounts.pool.stake_mint;
    let pool_bump = ctx.accounts.pool.bump;
    let seeds: &[&[u8]] = &[StakePool::SEED, stake_mint_key.as_ref(), &[pool_bump]];
    let signer = &[seeds];
    let decimals = ctx.accounts.stake_mint.decimals;

    // 1) Transfer the refund (amount − penalty) from stake_vault back to user.
    //    The penalty stays in stake_vault (which also backs the stake-mint
    //    reward line) — no second transfer is needed, and doing one would
    //    double-mut-borrow the same AccountInfo.
    let cpi_refund = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        TransferChecked {
            from: ctx.accounts.stake_vault.to_account_info(),
            mint: ctx.accounts.stake_mint.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.pool.to_account_info(),
        },
        signer,
    );
    token_interface::transfer_checked(cpi_refund, refund, decimals)?;

    // 2) Subtract this position's footprint from the pool totals BEFORE we
    //    redistribute, so the exiting staker gets zero of their own penalty.
    let pool = &mut ctx.accounts.pool;
    pool.total_staked = pool
        .total_staked
        .checked_sub(amount)
        .ok_or(PobIndexStakeError::Overflow)?;
    pool.total_effective = pool
        .total_effective
        .checked_sub(effective)
        .ok_or(PobIndexStakeError::Overflow)?;

    // 3) Bump the stake-mint reward line's acc_per_share against the NEW
    //    total_effective. If the exiting user was the only staker in the pool,
    //    total_effective is now 0 and the penalty simply sits in stake_vault
    //    until a future staker + deposit_rewards call absorbs it. That's a
    //    rare edge case and keeps the math strict.
    let redistributed = if penalty > 0 && pool.total_effective > 0 {
        let reward = &mut ctx.accounts.stake_reward_mint;
        let add: u128 = (penalty as u128)
            .checked_mul(ACC_PRECISION)
            .and_then(|v| v.checked_div(pool.total_effective))
            .ok_or(PobIndexStakeError::Overflow)?;
        reward.acc_per_share = reward
            .acc_per_share
            .checked_add(add)
            .ok_or(PobIndexStakeError::Overflow)?;
        reward.total_deposited = reward
            .total_deposited
            .checked_add(penalty)
            .ok_or(PobIndexStakeError::Overflow)?;
        reward.last_deposit_ts = now;
        true
    } else {
        false
    };

    position.closed = true;

    emit!(UnstakedEarly {
        position: position.key(),
        owner: position.owner,
        amount,
        penalty,
        refund,
        redistributed,
        pool_total_effective_after: pool.total_effective,
        penalty_bps_applied: bps,
    });
    Ok(())
}

#[event]
pub struct UnstakedEarly {
    pub position: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub penalty: u64,
    pub refund: u64,
    pub redistributed: bool,
    pub pool_total_effective_after: u128,
    /// v4: the bps actually applied to the principal (resolved via
    /// `effective_early_unstake_bps`). Older clients ignore this field; new
    /// indexers can use it to break out per-attribution-category fee revenue.
    pub penalty_bps_applied: u32,
}
