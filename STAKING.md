# POB Index — Custom Proof of Belief staking

This repo ships a Printr-style POB staking pool built from scratch so we can
reward stakers with *other* Printr tokens (instead of the single-reward model
Printr's native POB enforces). Three moving parts:

| Path                             | What it is                                             |
| -------------------------------- | ------------------------------------------------------ |
| `staking-program/`               | Anchor on-chain program (`pob-index-stake`)            |
| `staking-sdk/`                   | JS/TS SDK + IDL JSON used by the UI and worker         |
| `src/stake/`                     | Phantom-wallet Stake view wired into the dashboard     |
| `pobindex-worker/src/stake-distribute.js` | Worker path that swaps SOL → reward mints and deposits them into the pool |
| `pobindex-worker/scripts/stake-admin.js` | CLI for `initialize_pool` / `add_reward_mint`    |

## POB tiers (mirrors Printr)

| Lock   | Multiplier |
| ------ | ---------- |
| 7 d    | 1.00 ×     |
| 14 d   | 1.10 ×     |
| 30 d   | 1.25 ×     |
| 60 d   | 1.50 ×     |
| 90 d   | 2.00 ×     |
| 180 d  | 3.00 ×     |

Effective stake = `amount × multiplier_bps / 10_000`. Rewards accrue via the
standard `acc_per_share` accumulator weighted by effective stake, so longer
locks earn a proportionally larger slice of every reward drop.

## Boot sequence

1. **Launch the POB Index mint** (SPL) or use a devnet placeholder.
2. **Build & deploy** the Anchor program (requires Rust + Solana CLI + Anchor
   0.31.1):
   ```bash
   cd staking-program
   anchor build
   # anchor keys list → paste the new program ID into:
   #   staking-program/Anchor.toml
   #   staking-program/programs/pob-index-stake/src/lib.rs (declare_id!)
   #   staking-sdk/src/idl.json ("address")
   anchor deploy --provider.cluster devnet
   ```
3. **Paste the program ID + mint** into both env files:
   ```bash
   # pobindex-worker/.env
   POB_STAKE_PROGRAM_ID=<program id>
   POB_STAKE_MINT=<pob index mint>
   POB_STAKE_DISTRIBUTE=1        # route creator fees to the pool
   ```
   ```bash
   # POBINDEX/.env.local (or injected at Vite build time)
   VITE_POB_STAKE_PROGRAM_ID=<program id>
   VITE_POB_STAKE_MINT=<pob index mint>
   VITE_SOLANA_RPC=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
   ```
4. **Initialize the pool** from the treasury wallet:
   ```bash
   cd pobindex-worker
   npm install     # picks up @coral-xyz/anchor + bn.js
   npm run stake:init
   ```
5. **Register reward mints** — every Printr token that might be selected for a
   reward cycle needs its own on-chain `RewardMint` account + vault (they're
   cheap — ~0.002 SOL of rent each). The easiest route is to sync from the
   latest POB snapshot:
   ```bash
   npm run discover           # writes public/pobindex-data.json
   npm run stake:sync-rewards # registers every mint in the snapshot
   ```
   Or add one explicitly:
   ```bash
   npm run stake:add-reward -- <REWARD_MINT>
   ```
6. **Cycle rewards.** Set `POB_STAKE_DISTRIBUTE=1` and run:
   ```bash
   npm run cycle
   ```
   The worker will, for each top-N Printr token, swap SOL → reward mint (into
   the treasury's ATA) and call `deposit_rewards` on the pool. The pool's
   `acc_per_share` advances, and every staker becomes eligible for their slice
   the moment the tx confirms.
7. **Users** connect Phantom on the site (`#stake` tab), pick an amount + lock,
   and sign the `stake` tx. Rewards appear per-reward-mint under each position
   and can be claimed independently. After `lock_end`, the `Unstake` button
   unlocks and returns the original principal.

## Safety notes

- The program PDA is the **sole signer** for both stake and reward vaults;
  there is no admin withdrawal path.
- `deposit_rewards` fails if `pool.total_effective == 0`, so early treasury
  deposits before anyone has staked won't be lost to no-op — they'll revert.
- There is no early-exit. If governance ever wants to add one, introduce a new
  instruction + a configurable `early_exit_bps`.
- `claim` is `init_if_needed` on the `RewardCheckpoint` PDA, so a user's first
  claim on a new reward mint pays the ATA rent itself.
