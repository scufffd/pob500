use anchor_lang::prelude::*;

#[error_code]
pub enum PobIndexStakeError {
    #[msg("Lock duration is not one of the allowed POB tiers")]
    InvalidLockTier,
    #[msg("Stake amount must be greater than zero")]
    ZeroAmount,
    #[msg("Reward amount must be greater than zero")]
    ZeroReward,
    #[msg("Lock has not expired yet")]
    LockNotExpired,
    #[msg("Lock has already expired — use `unstake` instead of `unstake_early`")]
    LockAlreadyExpired,
    #[msg("Stake-mint reward line is not registered; admin must call add_reward_mint for the stake mint")]
    StakeMintRewardNotRegistered,
    #[msg("Position is already closed")]
    PositionClosed,
    #[msg("Pool is paused")]
    Paused,
    #[msg("Reward mint does not belong to this pool")]
    MintMismatch,
    #[msg("Position does not belong to this pool")]
    PoolMismatch,
    #[msg("Stake vault has no effective stake; nothing to accrue")]
    NoEffectiveStake,
    #[msg("Numeric overflow")]
    Overflow,
    #[msg("Signer is not the pool authority")]
    NotAuthority,
    #[msg("Beneficiary must not be the default pubkey")]
    InvalidBeneficiary,
    #[msg("Reward payout ATA must be owned by the position owner")]
    WrongRewardRecipient,
    #[msg("Vault balance is less than the post-bump outstanding entitlement; specified amount exceeds the true orphan")]
    InsufficientVaultForRedistribute,
}
