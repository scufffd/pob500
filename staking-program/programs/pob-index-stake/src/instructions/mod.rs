pub mod add_reward_mint;
pub mod claim;
pub mod claim_push;
pub mod deposit_rewards;
pub mod initialize_pool;
pub mod prime_checkpoint;
pub mod stake;
pub mod stake_for;
pub mod unstake;
pub mod unstake_early;

// Anchor's `#[program]` macro relies on globs to pull in the generated
// `__client_accounts_*` / `__cpi_client_accounts_*` helper modules, so we
// have to accept the benign `ambiguous_glob_reexports` warning about each
// instruction module exporting its own `handler` symbol.
#[allow(ambiguous_glob_reexports)]
pub use add_reward_mint::*;
#[allow(ambiguous_glob_reexports)]
pub use claim::*;
#[allow(ambiguous_glob_reexports)]
pub use claim_push::*;
#[allow(ambiguous_glob_reexports)]
pub use deposit_rewards::*;
#[allow(ambiguous_glob_reexports)]
pub use initialize_pool::*;
#[allow(ambiguous_glob_reexports)]
pub use prime_checkpoint::*;
#[allow(ambiguous_glob_reexports)]
pub use stake::*;
#[allow(ambiguous_glob_reexports)]
pub use stake_for::*;
#[allow(ambiguous_glob_reexports)]
pub use unstake::*;
#[allow(ambiguous_glob_reexports)]
pub use unstake_early::*;
