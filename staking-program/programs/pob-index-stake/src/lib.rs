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
}
