use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("65YrGaBL5ukm4SVcsEBoUgnqTrNXy2pDiPKeQKjSexVA");

/// POB Index — Printr-style Proof of Belief staking.
///
/// Design:
///  - Users lock the POB Index native mint into a pool-owned vault for one of
///    six POB tiers (1, 3, 7, 14, 21, 30 days).
///  - Longer locks earn a bigger multiplier (1.0x → 3.0x) on their share of
///    pool rewards.
///  - Rewards can be any SPL / Token-2022 mint. Treasury creates a `RewardMint`
///    account + vault for each token it wants to distribute (e.g. BELIEF, fat
///    choi), then calls `deposit_rewards` to fund the pool; this updates a
///    MasterChef-style `acc_per_share` accumulator (scaled by 1e18) weighted
///    by effective stake.
///  - Each position has one `RewardCheckpoint` per reward mint it has interacted
///    with; `claim` catches the checkpoint up to the pool accumulator and pays
///    out the accrued balance. `claim_push` is the same settlement but signed by
///    `pool.authority` for optional worker auto-payouts.
///  - `unstake` is only valid after `lock_end`.
///  - `unstake_early` exits before `lock_end` with a flat 10% principal penalty
///    that redistributes to remaining stakers via the stake-mint reward line.
#[program]
pub mod pob_index_stake {
    use super::*;

    pub fn initialize_pool(ctx: Context<InitializePool>) -> Result<()> {
        initialize_pool::handler(ctx)
    }

    pub fn add_reward_mint(ctx: Context<AddRewardMint>) -> Result<()> {
        add_reward_mint::handler(ctx)
    }

    pub fn stake(ctx: Context<Stake>, amount: u64, lock_days: u32, nonce: u64) -> Result<()> {
        stake::handler(ctx, amount, lock_days, nonce)
    }

    /// Stake tokens on behalf of a beneficiary. Treasury / presale flow.
    pub fn stake_for(
        ctx: Context<StakeFor>,
        amount: u64,
        lock_days: u32,
        nonce: u64,
        beneficiary: Pubkey,
    ) -> Result<()> {
        stake_for::handler(ctx, amount, lock_days, nonce, beneficiary)
    }

    pub fn prime_checkpoint(ctx: Context<PrimeCheckpoint>) -> Result<()> {
        prime_checkpoint::handler(ctx)
    }

    pub fn deposit_rewards(ctx: Context<DepositRewards>, amount: u64) -> Result<()> {
        deposit_rewards::handler(ctx, amount)
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        claim::handler(ctx)
    }

    /// Authority-settled claim: same as `claim` but `pool.authority` signs (worker auto-payout).
    pub fn claim_push(ctx: Context<ClaimPush>) -> Result<()> {
        claim_push::handler(ctx)
    }

    pub fn unstake(ctx: Context<Unstake>) -> Result<()> {
        unstake::handler(ctx)
    }

    pub fn unstake_early(ctx: Context<UnstakeEarly>) -> Result<()> {
        unstake_early::handler(ctx)
    }

    // ---- v2 admin instructions (added in upgrade for SQWARK remediation
    // and ongoing operational headroom). All authority-gated. None modify
    // the math used by the value-bearing instructions above. ----

    /// Rotate `pool.authority`. See `set_pool_authority.rs` for rationale.
    pub fn set_pool_authority(
        ctx: Context<SetPoolAuthority>,
        new_authority: Pubkey,
    ) -> Result<()> {
        set_pool_authority::handler(ctx, new_authority)
    }

    /// Flip `pool.paused`. The flag has been read by stake/stake_for since
    /// v1, but no setter existed. See `set_paused.rs` for the runbook
    /// context.
    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        set_paused::handler(ctx, paused)
    }

    /// Drain a reward vault to a specified ATA. Pool PDA signs the transfer.
    /// `amount = 0` sweeps the full vault balance.
    pub fn sweep_reward_vault(ctx: Context<SweepRewardVault>, amount: u64) -> Result<()> {
        sweep_reward_vault::handler(ctx, amount)
    }

    /// Surgically rewrite an existing `RewardCheckpoint`'s `acc_per_share`
    /// (and zero its `claimable`). Used to fix wrongly-baselined checkpoints.
    pub fn admin_reset_checkpoint(
        ctx: Context<AdminResetCheckpoint>,
        new_acc_per_share: u128,
    ) -> Result<()> {
        admin_reset_checkpoint::handler(ctx, new_acc_per_share)
    }

    /// Wipe a reward line's accumulator + ledger fields. Used after a
    /// `sweep_reward_vault` to reset the math without redeploying the pool.
    pub fn admin_reset_reward_mint(
        ctx: Context<AdminResetRewardMint>,
        new_acc_per_share: u128,
        new_total_deposited: u64,
        new_total_claimed: u64,
    ) -> Result<()> {
        admin_reset_reward_mint::handler(
            ctx,
            new_acc_per_share,
            new_total_deposited,
            new_total_claimed,
        )
    }

    // ---- v3 instructions ----

    /// **Permissionless** orphan recovery — any caller can re-attribute
    /// reward balance left behind by stakers who unstaked without claiming.
    /// Math always favours current active stakers; over-specified amounts
    /// revert with `InsufficientVaultForRedistribute`. See
    /// `redistribute_orphan.rs` for the full protocol-level rationale.
    pub fn redistribute_orphan(
        ctx: Context<RedistributeOrphan>,
        amount: u64,
    ) -> Result<()> {
        redistribute_orphan::handler(ctx, amount)
    }

    // ---- v4 instructions ----

    /// Authority-gated per-position early-unstake penalty override.
    /// Lets the platform configure differentiated penalties per attribution
    /// category (presale vs KOL vs organic) without redeploying. Capped at
    /// `MAX_EARLY_UNSTAKE_BPS` (50%). See
    /// `set_position_early_unstake_bps.rs` for the full rationale.
    pub fn set_position_early_unstake_bps(
        ctx: Context<SetPositionEarlyUnstakeBps>,
        bps: u16,
    ) -> Result<()> {
        set_position_early_unstake_bps::handler(ctx, bps)
    }
}
