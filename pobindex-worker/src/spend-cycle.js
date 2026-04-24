'use strict';

/**
 * Spend cycle — reads the current basket, allocates treasury SOL across
 * basket entries by weight, executes Raydium/Jupiter swaps, then calls
 * deposit_rewards on the staking pool for each mint that received tokens.
 *
 * This module does NOT refresh the basket or claim fees — those are separate
 * steps. Call them first (see scripts/run-loop.js).
 */

const fs = require('fs');
const path = require('path');
const { PublicKey } = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} = require('@solana/spl-token');

const config = require('./config');
const { logEvent, formatSol } = require('./utils');
const { swapSolToToken } = require('./distribute');
const { resolveStakingConfig, depositCreatorFeesToPool } = require('./stake-distribute');
const { loadCurrentBasket } = require('./basket');

const MIN_SPEND_LAMPORTS = Math.round(
  parseFloat(process.env.MIN_DISTRIBUTE_SOL || '0.02') * 1e9,
);

// A rent-exempt RewardCheckpoint PDA costs ~0.00173 SOL on mainnet (the exact
// number depends on the on-chain struct size). We use 0.002 SOL here as a
// slight over-estimate so we never miss a prime tx for ~770 lamports.
const RENT_PER_CHECKPOINT_LAMPORTS = parseInt(
  process.env.POB_STAKE_RENT_PER_CHECKPOINT_LAMPORTS || '2000000',
  10,
);
// Fixed budget kept on the treasury to cover claim_push + ATA idempotent
// creation tx fees for the upcoming reward-push batch. One push tx burns
// ~5000 lamports in base fee plus priority; 0.05 SOL covers ~100 txs.
const OPS_FEE_BUFFER_LAMPORTS = parseInt(
  process.env.POB_STAKE_OPS_FEE_BUFFER_LAMPORTS || '50000000',
  10,
);
// If the admin (pool-authority) wallet drops below this, we will NOT spend —
// without admin SOL the claim_push phase can't sign. Keeps the treasury from
// racing ahead while Brr starves.
const ADMIN_MIN_LAMPORTS = parseInt(
  process.env.POB_ADMIN_MIN_LAMPORTS || '20000000',
  10,
);

/**
 * Estimate the SOL the treasury must keep in reserve to safely run the
 * upcoming prime_checkpoint + claim_push phases.
 *
 * Returns an upper bound (positions × reward-mints × rent) so we never
 * over-spend and find ourselves unable to create checkpoints — the root
 * cause of the 2026-04-24 reward blackout where prime_checkpoint failed
 * with `Transfer: insufficient lamports 967217, need 1733040` and rewards
 * stopped flowing for 7 hours.
 */
async function estimateStakingOpsReserveLamports({ connection, poolPk }) {
  try {
    const anchor = require('@coral-xyz/anchor');
    const { StakingClient } = require('../../staking-sdk/src/client');
    const sk = (process.env.STAKING_PROGRAM_ID || '').trim();
    if (!sk || !poolPk) return OPS_FEE_BUFFER_LAMPORTS;
    const wallet = new anchor.Wallet(anchor.web3.Keypair.generate());
    const provider = new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed' });
    const client = new StakingClient(provider, new PublicKey(sk));
    await client.init();
    const poolAcc = await client.program.account.stakingPool.fetchNullable(poolPk);
    const rewardMintCount = poolAcc?.rewardMints?.length || 0;
    if (rewardMintCount === 0) return OPS_FEE_BUFFER_LAMPORTS;
    const positions = await client.program.account.position.all();
    const activeCount = positions.filter((p) => !(p.account.amount?.isZero && p.account.amount.isZero())).length;
    // Max bound: every active position × every reward mint could need a
    // checkpoint created this cycle. Real number is usually lower because
    // existing checkpoints are reused, but we'd rather over-reserve.
    const maxCheckpoints = activeCount * rewardMintCount;
    return OPS_FEE_BUFFER_LAMPORTS + maxCheckpoints * RENT_PER_CHECKPOINT_LAMPORTS;
  } catch (e) {
    logEvent('warn', 'Failed to estimate staking ops reserve — falling back to fee buffer only', {
      error: e.message || String(e),
    });
    return OPS_FEE_BUFFER_LAMPORTS;
  }
}

/**
 * Given basket entries (with weight ∈ [0,1]) and a total distributable
 * lamport budget, compute per-entry lamport budgets that:
 *  1. sum to ≤ distLamports
 *  2. every surviving entry gets ≥ MIN_SPEND_LAMPORTS (Jupiter mins etc.)
 *  3. tokens whose weighted share would fall below min are dropped; their
 *     share is redistributed pro-rata to the survivors
 */
function allocateBudgets(entries, distLamports, minLamports = MIN_SPEND_LAMPORTS) {
  if (!entries || entries.length === 0) return [];
  if (distLamports < minLamports) return [];

  let survivors = entries.map((e) => ({
    entry: e,
    weight: Math.max(0.0001, Number(e.weight) || 0),
    lamports: 0,
  }));

  // Iteratively drop any entry whose weighted budget would undershoot min.
  // Cap at N iterations (can never exceed entries.length).
  for (let i = 0; i < entries.length; i += 1) {
    const wSum = survivors.reduce((s, r) => s + r.weight, 0) || 1;
    let dropped = false;
    const next = [];
    for (const r of survivors) {
      const budget = Math.floor((distLamports * r.weight) / wSum);
      if (budget < minLamports) {
        dropped = true;
        continue; // drop — its weight evaporates; others get more next pass
      }
      next.push({ ...r, lamports: budget });
    }
    survivors = next;
    if (!dropped) break;
    if (survivors.length === 0) return [];
  }

  // Any leftover lamports (from integer flooring) go to the top-weighted entry.
  const allocated = survivors.reduce((s, r) => s + r.lamports, 0);
  const leftover = distLamports - allocated;
  if (leftover > 0 && survivors.length > 0) {
    survivors.sort((a, b) => b.weight - a.weight);
    survivors[0].lamports += leftover;
  }

  return survivors.map((r) => ({
    mint: r.entry.mint,
    symbol: r.entry.symbol,
    weight: r.weight,
    lamports: r.lamports,
    sol: r.lamports / 1e9,
  }));
}

async function getTokenProgramForMint(mintPk) {
  const info = await config.connection.getAccountInfo(mintPk);
  if (!info) throw new Error(`Mint ${mintPk.toBase58()} not found on discovery cluster`);
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  throw new Error(`Mint ${mintPk.toBase58()} owner ${info.owner.toBase58()} is not a token program`);
}

async function readAtaBalance(ata) {
  try {
    const info = await config.connection.getTokenAccountBalance(ata);
    return BigInt(info.value.amount);
  } catch {
    return 0n;
  }
}

/**
 * @param {object} opts
 * @param {import('@solana/web3.js').Keypair} opts.treasury
 * @param {boolean} [opts.dryRun]
 * @param {object}  [opts.basket] override current basket (useful for tests)
 */
async function runSpendCycle({ treasury, dryRun = false, basket: overrideBasket = null } = {}) {
  const stakingCfg = resolveStakingConfig();
  if (!stakingCfg.enabled) {
    return { skipped: 'staking_disabled' };
  }

  const basket = overrideBasket || loadCurrentBasket();
  if (!basket || !Array.isArray(basket.entries) || basket.entries.length === 0) {
    return { skipped: 'no_basket' };
  }

  const onlyRegistered = basket.entries.filter((e) => e.registered !== false);
  if (onlyRegistered.length === 0) {
    return { skipped: 'no_registered_entries', basketVersion: basket.version };
  }

  const bal = await config.connection.getBalance(treasury.publicKey);

  // Gate the spend on admin (Brr / pool-authority) SOL. Without it, claim_push
  // can't sign the reward-distribution txs, so buying basket tokens this cycle
  // just parks value that can't be handed to stakers until Brr is refilled.
  let adminPubkey = null;
  try {
    const adminRaw = (process.env.ADMIN_PRIVATE_KEY || '').trim();
    if (adminRaw) adminPubkey = config.parsePrivateKey(adminRaw).publicKey;
  } catch (e) {
    // Non-fatal — treat as absent.
  }
  if (adminPubkey) {
    try {
      const adminBal = await config.connection.getBalance(adminPubkey);
      if (adminBal < ADMIN_MIN_LAMPORTS) {
        logEvent('warn', 'Spend cycle skipped — admin/authority SOL too low for reward push', {
          admin: adminPubkey.toBase58(),
          adminSol: adminBal / 1e9,
          minAdminSol: ADMIN_MIN_LAMPORTS / 1e9,
          treasurySol: bal / 1e9,
        });
        return {
          skipped: 'admin_sol_too_low',
          adminSol: adminBal / 1e9,
          minAdminSol: ADMIN_MIN_LAMPORTS / 1e9,
          treasuryBalanceSol: bal / 1e9,
          basketVersion: basket.version,
        };
      }
    } catch (e) {
      logEvent('warn', 'Admin balance probe failed — proceeding with treasury-only guardrails', {
        error: e.message || String(e),
      });
    }
  }

  // Dynamic reserve: base static reserve + enough SOL to cover the prime +
  // reward-push costs that fire right after this spend. Without this, a busy
  // pool drains treasury until prime_checkpoint fails `insufficient lamports`
  // and rewards silently stop flowing.
  const poolPk = stakingCfg.pool ? new PublicKey(stakingCfg.pool) : null;
  const dynamicOpsReserve = await estimateStakingOpsReserveLamports({
    connection: config.connection,
    poolPk,
  });
  const effectiveReserve = Math.max(config.SOL_RESERVE_LAMPORTS, dynamicOpsReserve);
  const available = Math.max(0, bal - effectiveReserve);
  const distLamports = Math.floor((available * config.DIST_PCT) / 100);

  if (distLamports < MIN_SPEND_LAMPORTS) {
    logEvent('warn', 'Spend cycle skipped — treasury below ops-safe threshold', {
      treasurySol: bal / 1e9,
      staticReserveSol: config.SOL_RESERVE_LAMPORTS / 1e9,
      dynamicOpsReserveSol: dynamicOpsReserve / 1e9,
      effectiveReserveSol: effectiveReserve / 1e9,
      distributableSol: distLamports / 1e9,
      minSpendSol: MIN_SPEND_LAMPORTS / 1e9,
      hint: 'Top up the treasury (bank) wallet. Rewards still push from existing SOL.',
    });
    return {
      skipped: 'below_min_spend',
      basketVersion: basket.version,
      treasuryBalanceSol: bal / 1e9,
      effectiveReserveSol: effectiveReserve / 1e9,
      distributableSol: distLamports / 1e9,
      minSpendSol: MIN_SPEND_LAMPORTS / 1e9,
    };
  }

  const budgets = allocateBudgets(onlyRegistered, distLamports);
  if (budgets.length === 0) {
    return {
      skipped: 'all_entries_below_min_after_allocation',
      distributableSol: distLamports / 1e9,
      minSpendSol: MIN_SPEND_LAMPORTS / 1e9,
    };
  }

  logEvent('info', 'Spend cycle — starting swaps', {
    basketVersion: basket.version,
    entries: budgets.length,
    totalBudgetSol: budgets.reduce((s, b) => s + b.sol, 0),
  });

  const swaps = [];
  const payouts = [];

  for (const b of budgets) {
    const mintPk = new PublicKey(b.mint);
    let tokenProgram;
    try {
      tokenProgram = await getTokenProgramForMint(mintPk);
    } catch (e) {
      swaps.push({ ...b, error: e.message });
      continue;
    }
    const ata = getAssociatedTokenAddressSync(mintPk, treasury.publicKey, false, tokenProgram);
    const beforeRaw = await readAtaBalance(ata);

    if (dryRun) {
      swaps.push({ ...b, dryRun: true });
      continue;
    }

    try {
      await swapSolToToken({
        devKeypair: treasury,
        outputMint: b.mint,
        amountLamports: b.lamports,
        slippageBps: parseInt(process.env.STAKE_SWAP_SLIPPAGE_BPS || '100', 10),
        label: `POB-stake:${b.symbol}`,
      });
    } catch (e) {
      swaps.push({ ...b, error: `swap_failed: ${e.message || e}` });
      continue;
    }

    const afterRaw = await readAtaBalance(ata);
    const delta = afterRaw > beforeRaw ? afterRaw - beforeRaw : 0n;
    if (delta === 0n) {
      swaps.push({ ...b, error: 'swap_produced_zero' });
      continue;
    }
    swaps.push({ ...b, swappedRaw: delta.toString() });
    payouts.push({ mint: b.mint, amount: delta });
  }

  let depositResult = { deposited: [], skipped: [] };
  if (!dryRun && payouts.length > 0) {
    depositResult = await depositCreatorFeesToPool({ treasury, payouts });
  } else if (dryRun) {
    depositResult = { deposited: [], skipped: payouts.map((p) => ({ ...p, reason: 'dry_run' })) };
  }

  logEvent('info', 'Spend cycle — done', {
    basketVersion: basket.version,
    swaps: swaps.length,
    depositsSucceeded: depositResult.deposited.length,
    depositsSkipped: depositResult.skipped.length,
    dryRun,
  });

  return {
    completedAt: new Date().toISOString(),
    basketVersion: basket.version,
    treasuryBalanceSol: bal / 1e9,
    distributableSol: distLamports / 1e9,
    budgets,
    swaps,
    deposit: depositResult,
    dryRun,
  };
}

module.exports = {
  MIN_SPEND_LAMPORTS,
  allocateBudgets,
  runSpendCycle,
};
