#!/usr/bin/env node
'use strict';

/**
 * test-reward-staker.js — manual end-to-end reward test.
 *
 *   1. Reads dev-wallet SOL (simulating "claimed creator fees")
 *   2. Refreshes the basket on mainnet — this picks the current top-N
 *      Printr tokens from the snapshot and registers each as a reward_mint
 *      on the pob-index-stake pool (idempotent).
 *   3. Runs a spend cycle — swaps dev-wallet SOL across basket tokens and
 *      calls deposit_rewards for every mint that received tokens.
 *
 * Output is a structured summary written to stdout. The production snapshot
 * (public/pobindex-data.json) is NOT touched.
 *
 * Required env (sourced from /tmp/full-flow-env.sh + worker .env):
 *   STAKE_RPC_URL           (mainnet Helius)
 *   RPC_URL                 (mainnet Helius)
 *   POB_STAKE_PROGRAM_ID    (65YrG…)
 *   POB_STAKE_MINT          (8C82…brrr)
 *   POB_STAKE_DISTRIBUTE=1
 *   TREASURY_PRIVATE_KEY    (dev wallet)
 *   ADMIN_PRIVATE_KEY       (dev wallet)
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const config = require('../src/config');
const { refreshBasket, loadCurrentBasket } = require('../src/basket');
const { runSpendCycle } = require('../src/spend-cycle');
const { resolveStakingConfig } = require('../src/stake-distribute');
const { claimViaPrintrTemplate } = require('../src/creator-sweep');

function requireEnv(key) {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env: ${key}`);
  return v;
}

(async () => {
  if (String(process.env.POB_STAKE_DISTRIBUTE || '0') !== '1') {
    throw new Error('POB_STAKE_DISTRIBUTE must be =1 for the reward pipeline to run');
  }

  const cfg = resolveStakingConfig();
  if (!cfg.enabled) throw new Error('resolveStakingConfig reports disabled');

  const treasury = config.parsePrivateKey(requireEnv('TREASURY_PRIVATE_KEY'));
  const admin = process.env.ADMIN_PRIVATE_KEY
    ? config.parsePrivateKey(process.env.ADMIN_PRIVATE_KEY)
    : treasury;

  const startBal = await config.stakeConnection.getBalance(treasury.publicKey, 'confirmed');

  console.log('── reward-staker test ──');
  console.log('programId:', cfg.programId.toBase58());
  console.log('stakeMint:', cfg.stakeMint.toBase58());
  console.log('pool     :', cfg.pool.toBase58());
  console.log('treasury :', treasury.publicKey.toBase58(), `(${(startBal / 1e9).toFixed(4)} SOL)`);
  console.log('admin    :', admin.publicKey.toBase58());
  console.log();

  console.log('[1/3] Claiming Printr creator fees via template replay…');
  const claim = await claimViaPrintrTemplate();
  console.log('  attempted       :', claim.attempted);
  console.log('  templateSig     :', claim.templateSig || '(none)');
  console.log('  instructionCount:', claim.instructionCount || 0);
  console.log('  skippedPrograms :', (claim.skippedPrograms || []).join(', ') || '(none)');
  if (claim.simulation) {
    console.log('  simErr          :', claim.simulation.err);
  }
  if (claim.sent) {
    console.log('  signature       :', claim.signature);
    const afterClaim = await config.stakeConnection.getBalance(treasury.publicKey, 'confirmed');
    console.log('  treasury SOL    :', (afterClaim / 1e9).toFixed(6), `(Δ ${((afterClaim - startBal) / 1e9).toFixed(6)})`);
  } else {
    console.log('  NOT SENT:', claim.reason || 'see simulation');
  }
  console.log();

  console.log('[2/3] Refreshing basket on mainnet (top Printrs → add_reward_mint)…');
  const basket = await refreshBasket({ adminKeypair: admin, dryRun: false });
  console.log('  version:', basket.version);
  console.log('  size   :', basket.entries.length);
  console.log('  newcomers:', basket.newcomers);
  basket.entries.forEach((e, i) => {
    console.log(`    [${i + 1}] ${e.symbol.padEnd(10)} ${e.mint}  weight=${e.weight}  tokenProgram=${e.tokenProgram || '?'}  registered=${e.registered}`);
  });
  basket.registrationResults.forEach((r) => {
    if (r.error) console.log(`    ! register error ${r.mint}: ${r.error}`);
    else if (r.status && r.status !== 'already') console.log(`    ✓ register ${r.mint}: ${r.status}${r.signature ? ' sig=' + r.signature : ''}`);
  });
  console.log();

  console.log('[3/3] Running spend cycle (SOL → basket → deposit_rewards)…');
  const spend = await runSpendCycle({ treasury, dryRun: false });
  console.log(JSON.stringify(spend, null, 2));

  const endBal = await config.stakeConnection.getBalance(treasury.publicKey, 'confirmed');
  console.log('\ntreasury SOL after:', (endBal / 1e9).toFixed(4), `(Δ ${((endBal - startBal) / 1e9).toFixed(4)})`);
})().catch((e) => {
  console.error('FAILED:', e.stack || e.message || e);
  process.exit(1);
});
