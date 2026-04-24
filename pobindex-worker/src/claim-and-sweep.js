'use strict';

/**
 * Thin orchestration helper: claim creator fees via Printr template replay,
 * then sweep any balance sitting on creator wallets into the treasury.
 *
 * Cheap to call often — both steps no-op safely when there's nothing to do.
 */

const { logEvent } = require('./utils');
const { claimViaPrintrTemplate, sweepCreatorWallets } = require('./creator-sweep');

/**
 * @param {object} opts
 * @param {import('@solana/web3.js').PublicKey} opts.treasuryPubkey  — sweep destination
 * @returns {Promise<{claim: any, sweep: any}>}
 */
async function runClaimAndSweep({ treasuryPubkey }) {
  let claim = null;
  let sweep = null;
  try {
    claim = await claimViaPrintrTemplate();
    if (claim && claim.attempted && !claim.sent && claim.simulation?.err) {
      // After the counter crosses the rediscovery threshold we escalate to
      // warn — that way ops noise stays quiet during normal "no fees yet"
      // oscillations, but a genuinely stuck template lights up.
      const stuck = claim.consecutiveSimFailures
        && claim.consecutiveSimFailures >= 3;
      logEvent(
        stuck ? 'warn' : 'info',
        stuck
          ? 'Printr claim stuck on repeated sim failures — will auto-rediscover template next cycle'
          : 'Printr claim skipped after simulation (no claimable fees or template mismatch)',
        {
          err: claim.simulation.err,
          templateSig: claim.templateSig || null,
          consecutiveSimFailures: claim.consecutiveSimFailures || 0,
          willRediscoverNextCycle: !!claim.willRediscoverNextCycle,
        },
      );
    } else if (claim && claim.attempted && claim.sent) {
      // Summarize whether the replay actually moved SOL (typical "no quote
      // fees to distribute" log from Printr means tx lands but claims 0).
      const zeroFees = (claim.simulation?.logs || []).some((l) =>
        /no quote fees to distribute/i.test(l),
      );
      logEvent('info', 'Printr claim replayed', {
        signature: claim.signature,
        zeroFees,
        instructionCount: claim.instructionCount,
      });
    } else if (claim && !claim.attempted) {
      logEvent('info', 'Printr claim not attempted', { reason: claim.reason });
    }
  } catch (e) {
    logEvent('warn', 'Printr claim failed', { error: e.message || String(e) });
    claim = { error: e.message || String(e) };
  }
  try {
    sweep = await sweepCreatorWallets(treasuryPubkey);
  } catch (e) {
    logEvent('warn', 'Creator sweep failed', { error: e.message || String(e) });
    sweep = { error: e.message || String(e) };
  }
  return { claim, sweep };
}

module.exports = { runClaimAndSweep };
