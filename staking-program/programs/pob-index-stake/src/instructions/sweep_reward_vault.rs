use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::errors::PobIndexStakeError;
use crate::state::*;

/// Authority-only sweep of a reward vault to a specified recipient ATA.
/// The pool PDA signs the transfer (since it owns the vault). Used to:
///  - Drain stranded balances when a reward line is being decommissioned
///  - Recover orphaned tokens that built up in the vault from past
///    `unstake_early` penalty bumps that no current staker has a checkpoint
///    against (the SQWARK 51.4M case).
///  - Move funds during emergency response without needing a full program
///    upgrade per incident.
///
/// SAFETY: this DOES NOT touch `reward_mint.total_deposited` or
/// `total_claimed` — the bookkeeping fields stay as they were so any honest
/// `claim` against an existing checkpoint still computes correctly. After
/// a sweep that changes the vault balance below the (deposited - claimed)
/// invariant, the authority should follow up with `admin_reset_reward_mint`
/// to wipe the accumulator state and `admin_reset_checkpoint` for any
/// position whose checkpoint was already pinned at a non-zero acc_per_share
/// — otherwise pre-existing checkpoints would compute a payout that the
/// drained vault cannot honor (claim would fail with insufficient funds).
///
/// ⚠️  NO PRINCIPAL GUARD: when `mint == pool.stake_mint` (the SQWARK case
/// where the staked token is also registered as a reward line), the same
/// vault holds BOTH (a) staker principal accounted for by
/// `pool.total_staked` AND (b) reward/penalty balance from `unstake_early`
/// redistribution. Calling this with `amount == 0` will drain ALL of it,
/// including principal — leaving every active position unbacked. The
/// remediation runbook (May 2026) had to do this intentionally for SQWARK
/// and then return the principal manually from the recipient. A guarded
/// version was prototyped (errors `WouldDrainPrincipal` when reward ==
/// stake mint and amount > vault - total_staked) but not deployed; we
/// keep the unrestricted behavior on-chain so future emergency scenarios
/// retain full flexibility. When sweeping a stake-mint reward line:
///   1. Either pass an explicit `amount = vault_balance - pool.total_staked`
///   2. Or pass `0` and immediately return `pool.total_staked` worth from
///      the recipient ATA back to the pool PDA in a follow-up transfer.
///
/// `amount` of `0` means "sweep everything currently in the vault".
#[derive(Accounts)]
pub struct SweepRewardVault<'info> {
    #[account(
        has_one = authority @ PobIndexStakeError::NotAuthority,
    )]
    pub pool: Account<'info, StakePool>,

    pub authority: Signer<'info>,

    #[account(
        has_one = pool @ PobIndexStakeError::PoolMismatch,
        has_one = mint @ PobIndexStakeError::MintMismatch,
        has_one = vault @ PobIndexStakeError::MintMismatch,
    )]
    pub reward_mint: Account<'info, RewardMint>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// Destination ATA. Constraint enforces it's for the same mint, but it
    /// can be owned by any wallet — typically a backup-treasury wallet for
    /// stranded-fund recovery.
    #[account(
        mut,
        constraint = recipient_ata.mint == mint.key() @ PobIndexStakeError::MintMismatch,
    )]
    pub recipient_ata: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<SweepRewardVault>, amount: u64) -> Result<()> {
    let vault_balance = ctx.accounts.vault.amount;
    let send_amount = if amount == 0 {
        vault_balance
    } else {
        require!(amount <= vault_balance, PobIndexStakeError::ZeroAmount);
        amount
    };
    require!(send_amount > 0, PobIndexStakeError::ZeroAmount);

    let stake_mint_key = ctx.accounts.pool.stake_mint;
    let pool_bump = ctx.accounts.pool.bump;
    let seeds = &[StakePool::SEED, stake_mint_key.as_ref(), &[pool_bump]];
    let signer = &[&seeds[..]];
    let decimals = ctx.accounts.mint.decimals;
    let cpi = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        TransferChecked {
            from: ctx.accounts.vault.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.recipient_ata.to_account_info(),
            authority: ctx.accounts.pool.to_account_info(),
        },
        signer,
    );
    token_interface::transfer_checked(cpi, send_amount, decimals)?;

    emit!(RewardVaultSwept {
        pool: ctx.accounts.pool.key(),
        reward_mint: ctx.accounts.reward_mint.key(),
        mint: ctx.accounts.mint.key(),
        recipient: ctx.accounts.recipient_ata.key(),
        amount: send_amount,
        vault_balance_before: vault_balance,
    });
    Ok(())
}

#[event]
pub struct RewardVaultSwept {
    pub pool: Pubkey,
    pub reward_mint: Pubkey,
    pub mint: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub vault_balance_before: u64,
}
