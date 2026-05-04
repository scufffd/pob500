use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::errors::PobIndexStakeError;
use crate::state::*;

/// **Permissionless** redistribution of orphaned reward balance back to the
/// active stakers of a pool.
///
/// Background — how orphan forms:
///   `deposit_rewards` (or an `unstake_early` penalty bump) increments
///   `reward_mint.acc_per_share` proportional to `pool.total_effective` at
///   that moment. Every staker present at that instant becomes entitled to a
///   share of the deposit. If a staker later closes their position via
///   `unstake` / `unstake_early` *without first calling `claim`*, Anchor's
///   `close = owner` constraint cascade-closes their `RewardCheckpoint`. The
///   reward they were owed stays in the vault, but no checkpoint references
///   it — so the on-chain claim math can never pay it out. It is "orphaned".
///
/// What this instruction does:
///   1. Re-bumps `reward_mint.acc_per_share` by `(amount × ACC_PRECISION) /
///      pool.total_effective`, granting the orphan to *current* active stakers
///      proportional to their effective stake.
///   2. Bumps `reward_mint.total_deposited` by `amount` so the on-chain
///      accounting (`total_deposited - total_claimed == vault_balance`)
///      remains internally consistent.
///   3. Validates that `vault_balance >= total_deposited - total_claimed`
///      AFTER the bump — i.e. the caller cannot over-promise more than the
///      vault actually holds. If they do, the tx reverts and no state changes.
///
/// Why no signer is required:
///   The math always favours current stakers (they are the only accounts
///   that can claim against the bumped accumulator). A malicious caller can
///   only either (a) pass amount=0 (no-op, just wastes their own gas) or
///   (b) pass too much (validation reverts, no harm done). They cannot
///   redirect funds, drain the vault, or harm any user.
///
/// The off-chain caller (worker, community bot, frontend button) is
/// responsible for computing the correct orphan amount via:
///   ```
///   orphan = vault_balance - sum_over_active_positions[
///     cp.claimable +
///     (rm.acc_per_share - cp.acc_per_share) × pos.effective / ACC_PRECISION
///   ]
///   ```
/// A small safety margin (e.g. 0.1%) is recommended so rounding always
/// favours stakers.
///
/// Comparison with `admin_reset_reward_mint`:
///   Both can bump `acc_per_share`. The difference is that `admin_reset_*`
///   requires `pool.authority` to sign (used for surgical fixes during
///   incident response) and accepts arbitrary new values. This instruction
///   is permissionless and only adds (never overwrites) — it cannot lower
///   accumulators or zero out claimable, so it is safe to expose to any
///   caller.
#[derive(Accounts)]
pub struct RedistributeOrphan<'info> {
    pub pool: Account<'info, StakePool>,

    #[account(
        mut,
        has_one = pool @ PobIndexStakeError::PoolMismatch,
        has_one = mint @ PobIndexStakeError::MintMismatch,
        has_one = vault @ PobIndexStakeError::MintMismatch,
    )]
    pub reward_mint: Account<'info, RewardMint>,

    pub mint: InterfaceAccount<'info, Mint>,

    pub vault: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<RedistributeOrphan>, amount: u64) -> Result<()> {
    require!(amount > 0, PobIndexStakeError::ZeroAmount);
    require!(
        ctx.accounts.pool.total_effective > 0,
        PobIndexStakeError::NoEffectiveStake,
    );

    let reward_mint = &mut ctx.accounts.reward_mint;
    let vault_balance = ctx.accounts.vault.amount;

    let new_total_deposited = reward_mint
        .total_deposited
        .checked_add(amount)
        .ok_or(PobIndexStakeError::Overflow)?;

    // After the bump, on-chain "outstanding entitlement" must not exceed
    // what the vault actually holds. If the caller specified more than the
    // true orphan, reject — no state changes.
    let outstanding_after = new_total_deposited
        .checked_sub(reward_mint.total_claimed)
        .ok_or(PobIndexStakeError::Overflow)?;
    require!(
        vault_balance >= outstanding_after,
        PobIndexStakeError::InsufficientVaultForRedistribute,
    );

    let add: u128 = (amount as u128)
        .checked_mul(ACC_PRECISION)
        .and_then(|v| v.checked_div(ctx.accounts.pool.total_effective))
        .ok_or(PobIndexStakeError::Overflow)?;
    reward_mint.acc_per_share = reward_mint
        .acc_per_share
        .checked_add(add)
        .ok_or(PobIndexStakeError::Overflow)?;
    reward_mint.total_deposited = new_total_deposited;
    reward_mint.last_deposit_ts = Clock::get()?.unix_timestamp;

    emit!(OrphanRedistributed {
        reward_mint: reward_mint.key(),
        mint: reward_mint.mint,
        amount,
        acc_per_share: reward_mint.acc_per_share,
        vault_balance,
    });
    Ok(())
}

#[event]
pub struct OrphanRedistributed {
    pub reward_mint: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub acc_per_share: u128,
    pub vault_balance: u64,
}
