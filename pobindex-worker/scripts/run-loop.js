#!/usr/bin/env node
'use strict';

/**
 * POBINDEX long-running worker loop — the PM2 entrypoint.
 *
 * Every CYCLE_INTERVAL_MIN (default 10):
 *   1. Claim + sweep creator fees (cheap, often a no-op; claim simulates first —
 *      if there is nothing to claim, no tx is sent)
 *   2. If the basket is stale (older than BASKET_REFRESH_MIN), refresh it
 *      (also registers any newcomer reward mints on the staking pool)
 *   3. If the spend cooldown has elapsed (SPEND_INTERVAL_MIN), run a spend
 *      cycle: swap treasury SOL → basket tokens → deposit_rewards
 *   3b. If POB_STAKE_AUTO_PUSH_CLAIMS=1, batch `claim_push` so rewards land in
 *      staker wallets without manual claims (treasury must be pool authority).
 *   4. Re-run a light discover pass on the same cadence as SPEND_INTERVAL_MIN
 *
 * All three inner loops can run at independent cadences — they're reset
 * purely by elapsed wall time (no per-cycle coupling).
 *
 * Logs go to stdout (pick them up via `pm2 logs`). Signals are handled so
 * `pm2 stop` exits cleanly between cycles.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const config = require('../src/config');
const { logEvent } = require('../src/utils');
const { runClaimAndSweep } = require('../src/claim-and-sweep');
const {
  loadCurrentBasket,
  isStale,
  refreshBasket,
  basketRefreshIntervalMin,
} = require('../src/basket');
const { runSpendCycle } = require('../src/spend-cycle');
const { runCycle } = require('../src/runCycle');
const { resolveStakingConfig } = require('../src/stake-distribute');
const { pushRewardClaims } = require('../src/stake-push-rewards');

const CYCLE_INTERVAL_MIN = Math.max(1, parseInt(process.env.CYCLE_INTERVAL_MIN || '10', 10));
const SPEND_INTERVAL_MIN = Math.max(1, parseInt(process.env.SPEND_INTERVAL_MIN || '10', 10));
const JITTER_PCT = Math.max(0, parseFloat(process.env.CYCLE_JITTER_PCT || '0.1'));
const LOOP_MAX_BACKOFF_MIN = 5;

let stopped = false;
let lastSpendAt = 0;
let lastDiscoverAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredDelayMs(minutes) {
  const baseMs = minutes * 60_000;
  const spread = baseMs * JITTER_PCT;
  const offset = (Math.random() * 2 - 1) * spread;
  return Math.max(5_000, Math.round(baseMs + offset));
}

async function topUpAdminIfNeeded({ treasury, adminKeypair }) {
  if (!adminKeypair) return null;
  const MIN_LAMPORTS = parseInt(process.env.POB_ADMIN_MIN_LAMPORTS || '50000000', 10);
  const TARGET_LAMPORTS = parseInt(
    process.env.POB_ADMIN_TARGET_LAMPORTS || String(MIN_LAMPORTS * 4),
    10,
  );
  const MAX_SINGLE_TRANSFER = parseInt(
    process.env.POB_ADMIN_TOPUP_MAX_LAMPORTS || '500000000',
    10,
  ); // 0.5 SOL safety cap per cycle
  const connection = config.connection;
  const [adminBal, treasuryBal] = await Promise.all([
    connection.getBalance(adminKeypair.publicKey, 'confirmed'),
    connection.getBalance(treasury.publicKey, 'confirmed'),
  ]);
  if (adminBal >= MIN_LAMPORTS) return null;
  // For the top-up itself we only need to keep the treasury above its own
  // transaction-fee floor (SOL_RESERVE is the separate, larger floor for
  // the spend/swap cycle — gating top-ups on that would re-create the
  // deadlock where both wallets go flat at the same time).
  const TOPUP_TREASURY_FLOOR_LAMPORTS = parseInt(
    process.env.POB_ADMIN_TOPUP_TREASURY_FLOOR_LAMPORTS || '30000000',
    10,
  );
  const spare = Math.max(0, treasuryBal - TOPUP_TREASURY_FLOOR_LAMPORTS);
  if (spare < 10_000_000) {
    logEvent('warn', 'Admin top-up skipped — treasury also low', {
      adminSol: adminBal / 1e9,
      treasurySol: treasuryBal / 1e9,
      treasuryFloorSol: TOPUP_TREASURY_FLOOR_LAMPORTS / 1e9,
      hint: 'Fund the bank wallet to resume reward distribution.',
    });
    return null;
  }
  const needed = TARGET_LAMPORTS - adminBal;
  const amount = Math.min(needed, spare, MAX_SINGLE_TRANSFER);
  const {
    Transaction,
    SystemProgram,
    sendAndConfirmTransaction,
  } = require('@solana/web3.js');
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: treasury.publicKey,
      toPubkey: adminKeypair.publicKey,
      lamports: amount,
    }),
  );
  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [treasury], {
      commitment: 'confirmed',
    });
    logEvent('info', 'Admin auto-topped up from treasury', {
      admin: adminKeypair.publicKey.toBase58(),
      amountSol: amount / 1e9,
      priorAdminSol: adminBal / 1e9,
      postAdminSol: (adminBal + amount) / 1e9,
      signature: sig,
    });
    return { amountLamports: amount, signature: sig };
  } catch (e) {
    logEvent('warn', 'Admin auto-top-up failed', { error: e.message || String(e) });
    return null;
  }
}

async function runOnce({ treasury, adminKeypair, stakingEnabled, stakingConfigured }) {
  const snapshot = { startedAt: new Date().toISOString() };

  // 0) Keep Brr (pool authority) funded. Without SOL on the admin wallet the
  // spend/push cycle skips and rewards silently stall — the exact outage we
  // just debugged. Auto-topping up at the top of every cycle turns a quiet
  // failure into a self-healing operation as long as the treasury has SOL.
  try {
    const topup = await topUpAdminIfNeeded({ treasury, adminKeypair });
    if (topup) snapshot.adminTopUp = topup;
  } catch (e) {
    logEvent('warn', 'topUpAdminIfNeeded threw', { error: e.message });
  }

  // 1) Claim + sweep
  try {
    const { claim, sweep } = await runClaimAndSweep({ treasuryPubkey: treasury.publicKey });
    snapshot.claim = claim;
    snapshot.sweep = sweep;
  } catch (e) {
    snapshot.claimSweepError = e.message || String(e);
    logEvent('warn', 'claimAndSweep threw', { error: e.message });
  }

  // 2) Refresh basket if stale (only when staking is wired up)
  if (stakingEnabled) {
    let basket = loadCurrentBasket();
    if (!basket || isStale(basket)) {
      try {
        basket = await refreshBasket({ adminKeypair, treasuryKeypair: treasury });
        snapshot.basketRefreshed = { version: basket.version };
      } catch (e) {
        snapshot.basketError = e.message || String(e);
        logEvent('error', 'refreshBasket failed', { error: e.message });
      }
    } else {
      snapshot.basketRefreshed = { version: basket.version, reason: 'fresh' };
    }
  }

  // 3) Spend cycle (respects SPEND_INTERVAL_MIN cooldown)
  if (stakingEnabled && Date.now() - lastSpendAt >= SPEND_INTERVAL_MIN * 60_000) {
    try {
      const spend = await runSpendCycle({ treasury });
      snapshot.spend = spend;
      lastSpendAt = Date.now();
    } catch (e) {
      snapshot.spendError = e.message || String(e);
      logEvent('error', 'runSpendCycle failed', { error: e.message });
    }
  } else if (stakingEnabled) {
    const msLeft = SPEND_INTERVAL_MIN * 60_000 - (Date.now() - lastSpendAt);
    snapshot.spend = { skipped: 'cooldown', minutesUntilNext: Math.ceil(msLeft / 60_000) };
  }

  // 3b) Optional: authority-push accrued rewards to each staker's ATA (claim_push).
  // Runs whenever the pool is configured — independent of POB_STAKE_DISTRIBUTE.
  // Treasury (Bank) pays tx fees + ATA rent; adminKeypair only signs as pool
  // authority. This keeps the admin wallet from burning SOL on rent/fees.
  if (stakingConfigured && String(process.env.POB_STAKE_AUTO_PUSH_CLAIMS || '0') === '1') {
    try {
      snapshot.rewardPush = await pushRewardClaims({ treasury, authority: adminKeypair });
    } catch (e) {
      snapshot.rewardPushError = e.message || String(e);
      logEvent('warn', 'pushRewardClaims failed', { error: e.message });
    }
  }

  // 4) Keep the UI snapshot warm — run a discover-only pass if we haven't
  //    in the last SPEND_INTERVAL_MIN window. This refreshes pobindex-data.json
  //    with current Printr candidates, even if no spending happened.
  if (Date.now() - lastDiscoverAt >= SPEND_INTERVAL_MIN * 60_000) {
    try {
      await runCycle({ discoverOnly: true });
      lastDiscoverAt = Date.now();
    } catch (e) {
      snapshot.discoverError = e.message || String(e);
      logEvent('warn', 'discover-only pass failed', { error: e.message });
    }
  }

  return snapshot;
}

async function main() {
  process.on('SIGINT', () => { stopped = true; logEvent('info', 'SIGINT — finishing cycle and exiting'); });
  process.on('SIGTERM', () => { stopped = true; logEvent('info', 'SIGTERM — finishing cycle and exiting'); });

  logEvent('info', 'run-loop starting', {
    cycleMin: CYCLE_INTERVAL_MIN,
    spendMin: SPEND_INTERVAL_MIN,
    basketRefreshMin: basketRefreshIntervalMin(),
    jitterPct: JITTER_PCT,
  });

  const treasury = config.parsePrivateKey(config.requireEnv('TREASURY_PRIVATE_KEY'));
  const adminKeypair = process.env.ADMIN_PRIVATE_KEY
    ? config.parsePrivateKey(process.env.ADMIN_PRIVATE_KEY)
    : treasury;
  const stakingCfg = resolveStakingConfig();
  const stakingEnabled = !!stakingCfg.enabled;
  const stakingConfigured = !!stakingCfg.configured;

  logEvent('info', 'loop config resolved', {
    treasury: treasury.publicKey.toBase58(),
    admin: adminKeypair.publicKey.toBase58(),
    stakingEnabled,
    stakingConfigured,
  });

  let consecutiveErrors = 0;

  while (!stopped) {
    const t0 = Date.now();
    try {
      const snap = await runOnce({ treasury, adminKeypair, stakingEnabled, stakingConfigured });
      consecutiveErrors = 0;
      logEvent('info', 'cycle complete', {
        elapsedMs: Date.now() - t0,
        spent: !!(snap.spend && !snap.spend.skipped),
        basketVersion: snap.basketRefreshed?.version ?? null,
      });
    } catch (e) {
      consecutiveErrors += 1;
      logEvent('error', 'cycle failed', { error: e.message, stack: e.stack });
    }

    if (stopped) break;

    const backoffMin = Math.min(
      LOOP_MAX_BACKOFF_MIN,
      CYCLE_INTERVAL_MIN * Math.pow(2, Math.max(0, consecutiveErrors - 1)),
    );
    const delay = jitteredDelayMs(backoffMin);
    logEvent('debug', 'sleeping', { minutes: (delay / 60_000).toFixed(2) });
    await sleep(delay);
  }

  logEvent('info', 'run-loop exited cleanly');
  process.exit(0);
}

main().catch((e) => {
  console.error('run-loop fatal', e);
  process.exit(1);
});
