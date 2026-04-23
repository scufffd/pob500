# pob-index-stake

Solana Anchor program implementing a Printr-style Proof-of-Belief staking pool
for the POB Index native token. Users lock their tokens for a POB tier
(7 / 14 / 30 / 60 / 90 / 180 days → 1.0× / 1.1× / 1.25× / 1.5× / 2.0× / 3.0×)
and earn a share of rewards deposited by the treasury in **any** SPL mint —
typically the Printr tokens we receive as creator fees.

## Architecture

| Account            | Seeds                                                 | Purpose                                                  |
| ------------------ | ----------------------------------------------------- | -------------------------------------------------------- |
| `StakePool`        | `["pool", stake_mint]`                                | Pool config, totals, authority                            |
| `stake_vault`      | ATA(`stake_mint`, pool)                               | Holds all staked POB Index tokens                         |
| `RewardMint`       | `["reward", pool, mint]`                              | Per-reward accumulator (`acc_per_share`)                  |
| `reward_vault`     | ATA(`reward_mint`, pool)                              | Pool-owned vault for each reward token                    |
| `StakePosition`    | `["position", pool, owner, nonce_u64_le]`             | A single user lock (amount, multiplier, lock end)         |
| `RewardCheckpoint` | `["checkpoint", position, reward_mint]`               | Last-seen `acc_per_share` + unclaimed payout for the pair |

Rewards use the standard MasterChef pattern:

```
acc_per_share += amount_deposited * 1e18 / total_effective
claimable      = (acc_per_share - checkpoint.acc) * position.effective / 1e18
```

`effective = amount * multiplier_bps / 10_000`, so longer locks earn a
proportionally larger slice of every reward drop.

## Build & deploy

Requires Rust + Solana tool suite + Anchor 0.31.1.

```bash
cd staking-program
anchor build
# Take the new program ID printed by `anchor keys list`, update it in
# Anchor.toml and programs/pob-index-stake/src/lib.rs (declare_id!), rebuild.
anchor deploy --provider.cluster devnet
```

After deploy, copy the IDL anchor writes to `target/idl/pob_index_stake.json`
over the top of `../staking-sdk/src/idl.json` (the SDK ships with a hand-written
matching copy so the app works before the first build).

## Boot sequence

1. **Deploy program**, update `PROGRAM_ID` in `staking-sdk` and in the worker's
   `.env` (`POB_STAKE_PROGRAM_ID`).
2. **Launch the POB Index mint** (or use a placeholder on devnet). Give it a
   fixed supply, set authorities as desired.
3. Call `initialize_pool(stake_mint)` from the treasury wallet. This creates
   the `StakePool` PDA and its `stake_vault` ATA. Record the pool PDA in the
   SDK and worker env.
4. For each reward token the treasury wants to distribute (the Printr tokens
   picked by the POBINDEX worker), call `add_reward_mint(mint)`. This creates
   the per-reward accumulator + vault.
5. Users can now `stake(amount, lock_days, nonce)` via the site.
6. The worker, when it would normally airdrop creator-fee proceeds, instead
   funds the pool by calling `deposit_rewards(amount)` on each reward mint.
7. Users call `claim()` per reward mint, and `unstake()` once their lock expires.

## Notes / invariants

- `deposit_rewards` fails if `pool.total_effective == 0`; treasury should skip
  or accumulate until the pool has any stake.
- `unstake` closes the `StakePosition` and refunds its rent to the owner, but
  does **not** auto-claim rewards. Call `claim` for each reward mint first.
- There is no slashing or early exit. If governance ever wants to add a
  penalty-based early exit, introduce a new `early_unstake` instruction with a
  configurable `early_exit_bps` on the pool.
- The pool PDA is the sole token authority for every vault — there is no admin
  withdrawal path.
