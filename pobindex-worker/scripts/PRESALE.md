# POB500 presale distribution — playbook

This document describes how to take SOL contributions sent to the presale
wallet and convert them into on-chain POB500 stake positions owned by the
contributors.

## Overview

- Contributors send SOL to the **presale wallet**
  `AVhaEWooja5nUuihbYNs1oVDHFb2Y3oAZ3bu6SZApAS4` during the sale window.
- The dev wallet buys the initial POB500 supply (on DEX / bonding curve).
- A pre-agreed chunk of that supply (`POBINDEX_PRESALE_TOKEN_TOTAL`) is held
  in the **treasury ATA** and staked pro-rata on behalf of every contributor
  via the new `stake_for` instruction.
- Each contributor ends up owning an on-chain `StakePosition` with
  `position.owner == contributor_wallet`, locked for 7 days (1.50× multiplier).
- Contributors can immediately:
  - view their position in the **Stake** tab once they connect Phantom;
  - **claim** reward tokens as creator fees get swapped into the basket;
  - **unstake** after the 7-day lock with no penalty, **or**
  - **unstake_early** during the lock with the standard **10% principal
    penalty** (same as public stakers).

The dev wallet / treasury **cannot** reclaim or redirect contributor funds
once `stake_for` succeeds — `position.owner` is set to the contributor on
creation.

## Mainnet (dev buys supply)

Same scripts as devnet — point everything at **mainnet**:

1. **`RPC_URL`**, **`STAKE_RPC_URL`**, and **`POBINDEX_PRESALE_RPC_URL`**  
   Use your Helius (or other) mainnet endpoints. For a single-cluster setup you can
   set all three to the same URL.

2. **`POB_STAKE_MINT`** — the live POB500 mint. Run `npm run stake:init` once per
   mint, then `npm run stake:register-stake-reward`.

3. **Buy** the presale allocation into the **treasury’s ATA** for that mint (Jupiter
   / DEX / bonding curve — however you launch). Set **`POBINDEX_PRESALE_TOKEN_TOTAL`**
   to the raw units you will stake for contributors (≤ treasury balance).

4. **Presale SOL wallet** — set **`POBINDEX_PRESALE_WALLET`** to the address that
   receives contributor SOL on mainnet. `presale:scan` indexes that wallet only.

5. **`POBINDEX_PRESALE_STATE_DIR`** — use default `data/presale` (or a dedicated
   path) on the machine that runs the distributor.

6. **`npm run presale:scan`** → **`presale:preview`** → **`presale:distribute -- --live`**
   with **`TREASURY_PRIVATE_KEY`** signing on mainnet.

There is no separate “transfer staking perms” step: **`stake_for`** sets each
contributor as **`position.owner`** on creation; they claim / unstake with their
own wallet like any self-stake.

## Devnet rehearsal

Use a **separate state directory** and **devnet RPC for scanning** so you never
overwrite mainnet `contributions.json`:

```bash
export POBINDEX_PRESALE_STATE_DIR=data/presale-devnet
export POBINDEX_PRESALE_RPC_URL="$STAKE_RPC_URL"   # must be devnet for the drill
```

One-shot drill (creates 3 contributor wallets, simulates SOL presale, mints a
fresh SPL token, inits the pool, prints the exact `export …` lines for the
real presale scripts):

```bash
cd pobindex-worker
npm run presale:devnet-drill -- --all
```

Then run `presale:scan -- --full` → `presale:preview` → `presale:distribute -- --live`
as printed. Contributor secret keys land in `data/presale-devnet/drill-keys.json`
(import into Phantom to test claim / unstake as each wallet).

**Program:** deploy or `anchor upgrade` the devnet program that includes
`stake_for` before `presale:distribute -- --live`.

## Three-step workflow

### 1. Scan contributions

```bash
cd pobindex-worker
npm run presale:scan
```

- Reads every inbound `SystemProgram::transfer` to the presale wallet on the
  cluster configured by `POBINDEX_PRESALE_RPC_URL` (defaults to `RPC_URL`).
- Aggregates per-source wallet, ignoring self-transfers, failed txs, and
  anything below `POBINDEX_PRESALE_MIN_SOL`.
- Writes `data/presale/contributions.json`.

Re-running is incremental: it picks up from the last scanned signature.
Add `--full` to rescan from scratch.

On **Solana’s public devnet RPC**, `getParsedTransactions` batch calls often return
HTTP 429. Use **`--sequential-parsed`** (one `getParsedTransaction` per signature,
~250 ms apart) for reliable indexing, or point `POBINDEX_PRESALE_RPC_URL` at Helius
devnet with your API key.

Rate-limit tips:
- `--limit 500` / `--rpc-delay 600` lower the page size / spacing.
- `--max-pages 50` caps each run so you can stage big histories.

### 2. Preview allocations

Before spending tokens, set the token budget in `.env`:

```bash
# At 6 decimals, 10,000,000 tokens = 10_000_000 * 10^6
POBINDEX_PRESALE_TOKEN_TOTAL=10000000000000
POBINDEX_PRESALE_LOCK_DAYS=7
```

Then run:

```bash
npm run presale:preview                 # top 25
npm run presale:preview -- --top 200
npm run presale:preview -- --csv > preview.csv
```

The preview shows:
- each contributor's SOL in, % share, POB500 allocation;
- whether they've already been distributed (✔ vs ·);
- an estimated total rent + tx-fee cost for the distribution run.

Allocation math: integer floor on `lamports * tokenTotal / totalLamports`, with
the sub-token remainder redistributed to the largest contributors so the sum
equals `tokenTotal` exactly.

### 3. Distribute (dry-run → live)

Always start with a dry run to review the batch:

```bash
npm run presale:distribute -- --dry-run
```

Then broadcast:

```bash
npm run presale:distribute -- --live
npm run presale:distribute -- --live --limit 25       # chunk the run
npm run presale:distribute -- --live --only <WALLET>  # single wallet
```

What the distributor does per contributor:
1. Derives a fresh `StakePosition` PDA using nonce `time_seconds * 1000 + i`
   (guaranteed unique for the run).
2. Submits `stake_for(amount, lockDays, nonce, beneficiary)` from the
   treasury's POB500 ATA, writing `beneficiary` as `position.owner`.
3. Calls `prime_checkpoint` for every registered reward mint so the
   contributor accrues from that instant (no retro-claim of fees deposited
   before they joined).
4. All ixs are packed into the minimum number of 1200-byte transactions.
5. On success, writes an entry to `data/presale/distributed.json` so
   re-runs skip this wallet.

Safety rails:
- Default is `--dry-run`.
- Refuses to run if the pool is paused or the treasury ATA doesn't exist.
- Aborts if the treasury balance is less than the total allocation across
  remaining contributors.
- Idempotent — if tx 2 of 3 fails, re-running continues from tx 3 without
  re-staking anyone.

## After distribution — what contributors see

- In the **Stake** tab the contributor sees a position at 1.50× multiplier,
  countdown until `lock_end`, and pending rewards per basket token.
- **Claim** buttons send rewards to their wallet's ATAs as normal.
- **Unstake early** deducts 10% principal, returns 90% of the stake to their
  wallet, and redistributes the penalty to remaining stakers.
- **Unstake (after lock end)** returns 100% of principal + zero fees.

## Recovery / edge cases

- **Re-scan mid-presale**: safe; `contributions.json` merges new transfers
  with the existing set.
- **Contributor sent SOL twice**: both transfers aggregate into a single
  contributor row (sum of lamports).
- **Contributor refund**: after you refund someone, re-run `presale:scan`
  and **manually** remove them from `contributions.json` before
  `presale:distribute` (scan only sees inbound transfers, not refunds).
- **Partial distribution failure**: `distributed.json` has successful rows
  only; re-running resumes.
- **Token budget change**: edit `POBINDEX_PRESALE_TOKEN_TOTAL`, re-run
  preview, then distribute. Already-distributed wallets keep their original
  allocation; only new wallets are recomputed against the new total.
  (If you want a global re-allocation, delete `distributed.json` and
  `unstake` / refund manually before re-running — but that's rare.)

## Alternative flow: dev-buy + pro-rata airdrop

Instead of staking POB500 on behalf of contributors, you can pool the
contributed SOL into a single **dev-buy** at launch and airdrop the resulting
tokens pro-rata. This gives contributors raw tokens they can hold, stake
themselves, or sell.

```
presale wallet  ──(keep RESERVE)──►  deploy / ops wallet (manual)
                └──(send rest)────►  dev wallet  ──(+ DEV_EXTRA)──►  launch buy (T tokens)
                                                                    │
                      ┌──────────── presale_pool = T * fromPresale / devBuySol
                      │             dev_retained = T - presale_pool
                      ▼
               airdrop by SPL transfer, pro-rata to contributors
```

### Config (in `.env`)

```bash
POBINDEX_DEVBUY_RESERVE_SOL=2            # kept on presale wallet (you move it manually)
POBINDEX_DEVBUY_DEV_EXTRA_SOL=1          # dev adds on top of pooled SOL for the buy
POBINDEX_DEVBUY_WALLET_PRIVATE_KEY=...   # JSON array or bs58, signs the airdrop
POBINDEX_DEVBUY_MINT=<token mint>        # optional — can also be stored in plan file
```

### Commands

```bash
# 0. Refresh contributions.
npm run presale:scan

# 1. Preview percentages before the dev buy (no token count required).
npm run presale:devbuy-plan

# 2. After the dev buy lands, write the plan file with exact token amounts:
#    --tokens = RAW units returned by the dev buy
#    --mint   = mint pubkey (also read by presale:devbuy-send)
npm run presale:devbuy-plan -- --tokens 500000000000 --decimals 6 --mint <MINT>

# 3. Dry-run the airdrop.
npm run presale:devbuy-send -- --dry-run

# 4. Ship it.
npm run presale:devbuy-send -- --live
npm run presale:devbuy-send -- --live --limit 25
npm run presale:devbuy-send -- --live --only <WALLET>
```

### What the sender does

- Packs `createAssociatedTokenAccountIdempotent` + SPL `transfer` per
  contributor into as few 1200-byte txs as fit.
- Dev wallet pays ATA rent for recipients who do not yet have one.
- Checks dev-wallet ATA balance before sending; aborts on shortfall.
- Records each successful tx per-wallet in `data/presale/devbuy-sent.json`
  for idempotency. Re-runs skip already-airdropped wallets.

### Reserve SOL

The script never touches the reserve. You handle the 2 SOL (or whatever
`POBINDEX_DEVBUY_RESERVE_SOL` says) manually — typically a single
`solana transfer` from the presale wallet to whichever wallet will deploy the
smart contract. Leftover SOL on the presale wallet then goes to the dev wallet
and is the basis for the pro-rata split.

## Files

| File | Purpose |
|---|---|
| `data/presale/contributions.json` | Raw + aggregated inbound SOL |
| `data/presale/distributed.json`   | `stake_for` state per wallet (stake_for flow) |
| `data/presale/devbuy-plan.json`   | Pro-rata token plan after dev buy |
| `data/presale/devbuy-sent.json`   | Airdrop tx per wallet (idempotency) |
| `src/presale.js`                  | Shared module (scan/allocate/plan/format) |
| `scripts/presale-scan.js`         | CLI: index presale wallet |
| `scripts/presale-preview.js`      | CLI: dry-run `stake_for` allocations |
| `scripts/presale-distribute.js`   | CLI: idempotent `stake_for` batch |
| `scripts/presale-devbuy-plan.js`  | CLI: compute pro-rata plan after dev buy |
| `scripts/presale-devbuy-send.js`  | CLI: idempotent SPL airdrop to contributors |
