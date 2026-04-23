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
      logEvent(
        'info',
        'Printr claim skipped after simulation (no claimable fees or template mismatch)',
        { err: claim.simulation.err, templateSig: claim.templateSig || null },
      );
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
