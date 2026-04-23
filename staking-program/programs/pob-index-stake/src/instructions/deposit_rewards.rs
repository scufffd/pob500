use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::errors::PobIndexStakeError;
use crate::state::*;

#[derive(Accounts)]
pub struct DepositRewards<'info> {
    #[account(mut)]
    pub pool: Account<'info, StakePool>,

    #[account(
        mut,
        has_one = pool @ PobIndexStakeError::PoolMismatch,
        has_one = mint @ PobIndexStakeError::MintMismatch,
        has_one = vault @ PobIndexStakeError::MintMismatch,
    )]
    pub reward_mint: Account<'info, RewardMint>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub funder: Signer<'info>,

    #[account(
        mut,
        constraint = funder_token_account.mint == mint.key() @ PobIndexStakeError::MintMismatch,
        constraint = funder_token_account.owner == funder.key(),
    )]
    pub funder_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<DepositRewards>, amount: u64) -> Result<()> {
    require!(amount > 0, PobIndexStakeError::ZeroReward);
    require!(
        ctx.accounts.pool.total_effective > 0,
        PobIndexStakeError::NoEffectiveStake
    );

    let decimals = ctx.accounts.mint.decimals;
    let cpi = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        TransferChecked {
            from: ctx.accounts.funder_token_account.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.funder.to_account_info(),
        },
    );
    token_interface::transfer_checked(cpi, amount, decimals)?;

    let reward_mint = &mut ctx.accounts.reward_mint;
    let add: u128 = (amount as u128)
        .checked_mul(ACC_PRECISION)
        .and_then(|v| v.checked_div(ctx.accounts.pool.total_effective))
        .ok_or(PobIndexStakeError::Overflow)?;
    reward_mint.acc_per_share = reward_mint
        .acc_per_share
        .checked_add(add)
        .ok_or(PobIndexStakeError::Overflow)?;
    reward_mint.total_deposited = reward_mint
        .total_deposited
        .checked_add(amount)
        .ok_or(PobIndexStakeError::Overflow)?;
    reward_mint.last_deposit_ts = Clock::get()?.unix_timestamp;

    emit!(RewardsDeposited {
        reward_mint: reward_mint.key(),
        mint: reward_mint.mint,
        amount,
        acc_per_share: reward_mint.acc_per_share,
    });
    Ok(())
}

#[event]
pub struct RewardsDeposited {
    pub reward_mint: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub acc_per_share: u128,
}
