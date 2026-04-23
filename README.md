# POB500

Proof-of-Belief index on Solana — an auto-rebalancing basket of top Printr
tokens. Stake POB500, earn a rotating basket of the strongest launches as real
token rewards funded by creator fees, not emissions.

- Frontend: Vite + React, in `src/`
- Staking Anchor program: `staking-program/` (mainnet id in `Anchor.toml`)
- Off-chain worker: `pobindex-worker/` — claim, swap, deposit_rewards on a
  10-minute loop

All secrets (`.env`, keypairs, worker `data/`) are gitignored and live on the
deployment host only.
