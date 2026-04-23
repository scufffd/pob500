'use strict';

/**
 * Rebuild just the dashboard JSON (pobindex-data.json) from existing on-disk
 * state — basket-current.json, basket-history/, spend-history/, and a live
 * pool fetch. Does NOT run discovery, claim fees, swap, or deposit.
 *
 * Intended for after a worker/UI update when you want the dashboard to
 * reflect the new schema without waiting for the next scheduled cycle.
 *
 *   node scripts/rebuild-snapshot.js
 */

const fs = require('fs');
require('dotenv').config();

const config = require('../src/config');
const { logEvent } = require('../src/utils');
const { resolveStakingConfig, fetchPoolStateForDashboard } = require('../src/stake-distribute');
const { loadCurrentBasket, minutesUntilRefresh } = require('../src/basket');
const {
  aggregateFeesSwept,
  sweptInLastDays,
  basketTimeline,
  recentSwapsByMint,
} = require('../src/spend-history');

async function main() {
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(config.POBINDEX_DATA_JSON, 'utf8'));
  } catch (e) {
    logEvent('info', 'No existing snapshot — starting blank', { error: e.message });
  }

  const stakingCfg = resolveStakingConfig();
  const extras = {};
  try { extras.pool = await fetchPoolStateForDashboard(); } catch (e) {
    logEvent('warn', 'pool state unavailable', { error: e.message });
    extras.pool = null;
  }
  try { extras.feesSwept = aggregateFeesSwept(); } catch { extras.feesSwept = null; }
  try { extras.feesSwept7d = sweptInLastDays(7); } catch { extras.feesSwept7d = null; }
  try { extras.basketHistory = basketTimeline({ limit: 24 }); } catch { extras.basketHistory = []; }
  try { extras.recentSwaps = recentSwapsByMint({ perMintLimit: 8 }); } catch { extras.recentSwaps = {}; }

  const basket = loadCurrentBasket();
  const merged = {
    ...existing,
    stakeProgramId: stakingCfg.programId ? stakingCfg.programId.toBase58() : (existing.stakeProgramId ?? null),
    stakeMintAddress: stakingCfg.stakeMint ? stakingCfg.stakeMint.toBase58() : (existing.stakeMintAddress ?? null),
    stakingEnabled: !!stakingCfg.enabled,
    stakingPool: stakingCfg.pool ? stakingCfg.pool.toBase58() : (existing.stakingPool ?? null),
    ...extras,
    updatedAt: new Date().toISOString(),
  };
  if (basket) {
    merged.basket = {
      version: basket.version,
      createdAt: basket.createdAt,
      refreshIntervalMin: basket.refreshIntervalMin,
      minutesUntilRefresh: minutesUntilRefresh(basket),
      entries: basket.entries,
      pinned: basket.pinned,
      newcomers: basket.newcomers,
      dropped: basket.dropped,
    };
  }

  fs.writeFileSync(config.POBINDEX_DATA_JSON, JSON.stringify(merged, null, 2), 'utf8');
  logEvent('info', 'Rebuilt dashboard snapshot', {
    path: config.POBINDEX_DATA_JSON,
    poolInitialized: !!extras.pool?.initialized,
    feesSweptCycles: extras.feesSwept?.totalCycles || 0,
    basketHistoryCount: extras.basketHistory?.length || 0,
    recentSwapMints: Object.keys(extras.recentSwaps || {}).length,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
