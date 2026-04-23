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
  const available = Math.max(0, bal - config.SOL_RESERVE_LAMPORTS);
  const distLamports = Math.floor((available * config.DIST_PCT) / 100);

  if (distLamports < MIN_SPEND_LAMPORTS) {
    return {
      skipped: 'below_min_spend',
      basketVersion: basket.version,
      treasuryBalanceSol: bal / 1e9,
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
