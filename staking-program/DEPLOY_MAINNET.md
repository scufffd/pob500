# pob-index-stake — Mainnet Deploy & Security Runbook

This document covers:
1. Exact SOL cost for first-time deploy and future upgrades.
2. Security hardening steps before deploy.
3. Step-by-step deploy procedure.
4. Post-deploy verification checklist.

> **DO NOT skip any section.** The program is upgradeable by the `--upgrade-authority` only. Once deployed with a given authority, anyone in possession of that key can push arbitrary bytecode. Treat this key as the most sensitive asset in the project.

---

## 1) Cost to Deploy

The compiled `.so` (after the Token-2022 `token_interface` refactor) is **363,320 bytes** (see `target/deploy/pob_index_stake.so`).

Solana rent for an upgradeable program has three components:

| Account | Bytes | Purpose | Rent |
|---|---|---|---|
| `Program`       | 36              | Upgradeable loader Program record                             | **0.00114144 SOL** |
| `ProgramData`   | 45 + .so bytes  | Holds the deployed bytecode (permanent until closed)         | **2.52991128 SOL** (at exact size) |
| `Buffer` (temp) | 45 + .so bytes  | Write-staging account; closed + rent refunded on success     | (same as ProgramData) |

### Cost for a fresh deploy (no `--max-len`, no upgrade headroom)

- **Peak SOL held** during deploy (treasury must have this amount available):
  `0.00114144 + 2.52991128 + 2.52991128 ≈ 5.061 SOL`
- **Net cost after deploy completes** (buffer is closed + refunded):
  `0.00114144 + 2.52991128 ≈ 2.531 SOL`
- **Tx fees** (~1,200 chunked writes + deploy tx): budget **+0.015 SOL**.

**Budget a fresh deploy wallet with ≥ 5.1 SOL. Final net cost: ≈ 2.55 SOL.**

### Cost with `--max-len 726640` (2× headroom for future upgrades, recommended)

- **Peak SOL held**: `0.00114 + 5.05862 + 5.05862 ≈ 10.12 SOL`
- **Net cost after deploy**: `0.00114 + 5.05862 ≈ 5.060 SOL`
- Tx fees as above (~0.015 SOL).

**Budget ≥ 10.2 SOL. Final net cost: ≈ 5.08 SOL.**

> Recommendation: deploy with **`--max-len 726640`** (2× current size). A future larger upgrade will fail if the ProgramData is too small; extending later costs the same rent either way and requires a separate `solana program extend` tx.

### Upgrade cost (future versions)

If a future build is larger than current ProgramData:

1. `solana program extend <PROGRAM_ID> <ADDITIONAL_BYTES>` → permanent cost `6960 × delta` lamports.
2. Upgrade tx peak: needs buffer rent = `6960 × (173 + new_size)` SOL held temporarily (refunded).

If the new build **fits inside the existing ProgramData**, you just need buffer rent (refunded) + tx fees (~0.015 SOL). So with `--max-len` headroom applied up front, future upgrades cost ≈ **0.02 SOL + temporarily-held ≈ 2.5 SOL** per upgrade.

### Summary

| Scenario | Wallet must hold | Final net cost |
|---|---|---|
| Fresh deploy, exact size | 5.1 SOL | 2.55 SOL |
| Fresh deploy, `--max-len 726640` (2×)  | **10.2 SOL** | **5.08 SOL** |
| Upgrade, new build fits existing space  | 2.6 SOL | 0.015 SOL |
| Upgrade, new build needs N extra bytes  | 2.6 SOL + rent(N) | `0.01 + rent(N)` |

---

## 2) Security Hardening — Do Before Touching Mainnet

### 2.1 Program-ID keypair

**The program-ID keypair (`target/deploy/pob_index_stake-keypair.json`) must be unique per cluster.** Using the same keypair we used on devnet for mainnet is **unsafe** because:
- It's been on disk in a dev environment.
- It's been visible to local tooling and any process that touched `target/deploy`.

**Action** — generate a **new mainnet-only** keypair offline, air-gapped if possible:

```bash
# Air-gapped machine / secure laptop
solana-keygen new --no-bip39-passphrase -o pob_index_stake-MAINNET-keypair.json
solana-keygen pubkey pob_index_stake-MAINNET-keypair.json   # record this as the mainnet program id
```

Then update in three files:
- `Anchor.toml` → `[programs.mainnet] pob_index_stake = "<new pubkey>"`
- `programs/pob-index-stake/src/lib.rs` → `declare_id!("<new pubkey>");`
- `staking-sdk/src/idl.json` → `"address": "<new pubkey>"` (rebuild with `anchor build` regenerates this).

Re-run `anchor build` and **diff the new .so vs the current one**:
```bash
sha256sum target/deploy/pob_index_stake.so
```
Record and archive this hash — you'll verify it at deploy time.

### 2.2 Upgrade authority

The default behavior of `solana program deploy` is to set the upgrade authority to the **deployer's current CLI keypair**. This means whoever holds that key can push any bytecode to the program at any time.

**Production recommendation (in order of increasing security)**:

1. **Minimum acceptable**: a dedicated hardware-wallet-backed keypair (Ledger / Keystone) used *only* for upgrades. Not the same key used for day-to-day worker txs.
2. **Better**: Squads multisig as the upgrade authority (2-of-3 or 3-of-5 across distinct hardware wallets / team members).
3. **Optional, irreversible**: once confidence is established and code is finalized, call `solana program set-upgrade-authority --final <program_id>` to make the program **immutable forever**. This is one-way — it cannot be undone.

Do **not** set upgrade authority to the same key as `TREASURY_PRIVATE_KEY` that the worker runs with on the server — a compromised server would then be able to rewrite the contract.

### 2.3 Pool authority

The `pool.authority` field is **set at `initialize_pool`** and is used by the `add_reward_mint` instruction (via `has_one = authority`). It controls which mints can be registered for rewards.

This can be separate from the upgrade authority; recommended to be its own multisig too. The worker at runtime never needs pool-authority power — only when onboarding new reward mints, which is a human-supervised operation.

### 2.4 Keys / secrets inventory

Before mainnet:

- [ ] Mainnet program-ID keypair → offline, printed or sealed, **never** committed.
- [ ] Upgrade-authority keypair → hardware wallet or Squads multisig; not on any server.
- [ ] Pool-authority keypair → hardware wallet or Squads multisig.
- [ ] Worker treasury keypair (`TREASURY_PRIVATE_KEY`) → on the server in `.env`; holds ≤ budget it needs for fees + fee-payer; has **no** authority over the program.
- [ ] `.gitignore` confirms `.secrets/`, `*keypair*.json`, `.env` are excluded (already in place).
- [ ] Server hardening: `.env` is `chmod 600`, owned by non-root worker user; PM2 runs as that user.

### 2.5 Code review checklist

Items already enforced by the program:

- [x] `transfer_checked` on all moves (fails if decimals mismatch or transfer-hook denies).
- [x] `has_one` checks on every mutable PDA reference (pool ↔ stake_vault, pool ↔ reward_mint, pool ↔ position, reward_mint ↔ mint ↔ vault).
- [x] `owner` signer required for stake/claim/unstake; pool PDA signs only for vault-out transfers.
- [x] Rewards math in `u128` with explicit `ACC_PRECISION = 1e18`.
- [x] No early-exit on `unstake`; `require!(now >= lock_end)`.
- [x] `paused` flag on pool (checked in `stake`); emergency stop.
- [x] `checked_add/sub` on every arithmetic mutation.

Items to review before mainnet:

- [ ] **Transfer-fee reward mints**: `add_reward_mint` does not reject Token-2022 mints with the `TransferFee` extension. If a reward mint charges a transfer fee on deposit, the vault receives less than `acc_per_share` attributes, drifting the accounting. For **Printr tokens today**, none of the observed mints have transfer fees, but reviewers should `spl-token display <mint>` for each reward mint before calling `add-reward`.
- [ ] **Transfer hooks on Token-2022**: hooks run on every transfer and could fail; test each reward mint with a small `deposit_rewards` and `claim` on devnet before enabling on mainnet.
- [ ] **Reentrancy**: Solana single-tx state means CPIs can't re-enter the same program with fresh state, but still confirm the `claim` handler updates `checkpoint.claimable = 0` **after** the CPI transfer succeeds.
- [ ] **Event emission**: `emit!` only runs if the ix succeeds. Off-chain indexers will never see rewarded-but-reverted events.
- [ ] **Priority fees**: worker uses `ONE_TIME_PRIORITY_FEE` — ensure this is set reasonably (not 0) on mainnet so deposit txs land promptly in congested windows.
- [ ] Consider a professional audit (OtterSec, Neodyme, Kudelski) before accepting non-trivial TVL.

### 2.6 External audit recommendation

For any TVL > $25k, engage a security firm. Minimum scope:
- Anchor constraints review (`has_one`, PDA seeds, signer requirements)
- Math (integer overflow, rounding direction)
- CPI safety with Token-2022 (transfer hooks / fees)
- Lock-end enforcement around `i64` edge cases

---

## 3) Mainnet Deploy Procedure

### Pre-flight (1 day before)

1. **Pin the toolchain** — record versions:
   ```bash
   anchor --version        # expect: 0.31.0
   solana --version        # expect: 2.1.x or newer
   rustc --version
   ```
2. **Rebuild deterministically**:
   ```bash
   cd POBINDEX/staking-program
   anchor clean
   anchor build
   sha256sum target/deploy/pob_index_stake.so
   ```
   Archive this hash. It is what you'll confirm is on-chain.
3. **Manual review** of `programs/pob-index-stake/src/lib.rs` + `instructions/*.rs` + `Cargo.toml` diff vs last audited version.

### Deploy-day commands

Assuming:
- `UPGRADE_AUTHORITY_KEY` = hardware-wallet usb path or Squads multisig helper keypair
- `DEPLOYER_KEY` = ephemeral deployer with ≥ 10.2 SOL funded for the deploy (will be reimbursed if using Squads)
- `PROGRAM_ID_KEY` = freshly generated mainnet-only program-id keypair (Section 2.1)

```bash
# 1) Set cluster
solana config set --url https://api.mainnet-beta.solana.com
solana config set --keypair "$DEPLOYER_KEY"

# 2) Confirm balance ≥ 10.2 SOL
solana balance

# 3) Confirm .so hash matches the archived hash
sha256sum target/deploy/pob_index_stake.so

# 4) Deploy with 2× max-len and explicit upgrade authority
solana program deploy \
  --program-id "$PROGRAM_ID_KEY" \
  --upgrade-authority "$UPGRADE_AUTHORITY_KEY" \
  --max-len 726640 \
  --use-rpc \
  target/deploy/pob_index_stake.so

# If the deploy crashes mid-way, DO NOT panic — resume with:
# solana program deploy --buffer <BUFFER_KEYPAIR> ...
# The buffer retains all already-written bytes.
```

### Post-deploy sanity

```bash
# 5) Verify the deployed bytecode hash equals your local build
solana program show <PROGRAM_ID> --output json | jq -r .programdata_address
solana program dump <PROGRAM_ID> /tmp/deployed.so
sha256sum /tmp/deployed.so   # MUST match step 3

# 6) Confirm authority fields
solana program show <PROGRAM_ID>
#   Upgrade Authority: <your hardware / multisig> ← verify
#   Data Length      : 726640                     ← verify --max-len took effect
```

### Initialize pool on mainnet

With the new program ID in place:

```bash
# In POBINDEX/pobindex-worker/.env:
#   RPC_URL=<mainnet RPC>
#   STAKE_RPC_URL=<mainnet RPC>
#   POB_STAKE_PROGRAM_ID=<mainnet program id>
#   POB_STAKE_MINT=<mainnet POB mint>
#   ADMIN_PRIVATE_KEY=<pool-authority multisig helper signer or single-sig key>
#   TREASURY_PRIVATE_KEY=<worker runtime wallet>

npm run stake:init
# → emits initialize_pool ix, signs with ADMIN_PRIVATE_KEY
# → creates pool PDA + stake_vault ATA
```

### Register reward mints (one-by-one, audit before each)

```bash
npm run stake:add-reward -- <PRINTR_REWARD_MINT>
# Auto-detects Token-2022 vs legacy and wires the right program + ATA.
```

### Lock down (optional, irreversible)

Once the pool has been live long enough to prove the code is correct:

```bash
solana program set-upgrade-authority --final <PROGRAM_ID>
```
This removes upgrade capability forever. Do not do this until you're certain no upgrades will be needed.

---

## 4) Post-Deploy Verification

Run this script on a non-deployment machine (read-only):

```bash
# Verify program bytecode
solana program dump <PROGRAM_ID> /tmp/p.so
sha256sum /tmp/p.so  # must match build hash

# Verify pool state
solana account <POOL_PDA> --output json
#   authority  = <pool-authority>
#   stake_mint = <POB_STAKE_MINT>
#   paused     = false
#   reward_mint_count = <as expected>

# Verify stake_vault ownership
spl-token display <STAKE_VAULT_ADDRESS>
#   Owner: <pool PDA>
#   Mint : <POB_STAKE_MINT>

# Smoke test: one tiny deposit + claim with a test wallet
# (on mainnet, use ≤ 1 USD equivalent; verify flow works end-to-end)
```

---

## Appendix — Reference Values (populate after mainnet deploy)

| Field | Value |
|---|---|
| Program ID                | `<TBD>` |
| ProgramData Address       | `<TBD>` |
| Upgrade Authority         | `<TBD>` |
| Pool PDA                  | `<TBD>` |
| Pool Authority            | `<TBD>` |
| Stake Mint (POB Native)   | `<TBD>` |
| Stake Vault ATA           | `<TBD>` |
| `.so` SHA-256 at deploy   | `<TBD>` |
| Deploy signature          | `<TBD>` |
| Deploy block / slot       | `<TBD>` |
| `--max-len` used          | `726640` (2× binary size) |

---
