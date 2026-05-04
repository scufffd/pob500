use anchor_lang::prelude::*;

use crate::errors::PobIndexStakeError;
use crate::state::*;

/// Rotate the pool's authority key. The new authority becomes the only signer
/// allowed for downstream admin instructions (`add_reward_mint`, `claim_push`,
/// `set_paused`, `sweep_reward_vault`, `admin_reset_*`, ...).
///
/// Use cases:
///  - migrate ownership to a multisig
///  - rotate after a key compromise
///  - hand off a pool to a new operator
///
/// Refusing `Pubkey::default()` prevents accidentally bricking the pool — once
/// the authority is the zero pubkey, no one can sign for the pool ever again.
#[derive(Accounts)]
pub struct SetPoolAuthority<'info> {
    #[account(
        mut,
        has_one = authority @ PobIndexStakeError::NotAuthority,
    )]
    pub pool: Account<'info, StakePool>,

    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<SetPoolAuthority>, new_authority: Pubkey) -> Result<()> {
    require!(
        new_authority != Pubkey::default(),
        PobIndexStakeError::InvalidBeneficiary,
    );
    let pool = &mut ctx.accounts.pool;
    let old = pool.authority;
    pool.authority = new_authority;
    emit!(PoolAuthorityChanged {
        pool: pool.key(),
        old_authority: old,
        new_authority,
    });
    Ok(())
}

#[event]
pub struct PoolAuthorityChanged {
    pub pool: Pubkey,
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}
