'use strict';

/**
 * One-shot orchestration — runs every step of the POBINDEX pipeline exactly
 * once. Used by `npm run cycle` for manual ops. For production the worker
 * runs as a long-running loop instead (see scripts/run-loop.js).
 *
 *   1. Discover + score Printr candidates
 *   2. (if not discover-only) claim creator fees → sweep creator wallets → treasury
 *   3. (if not discover-only) refresh basket (register any newcomers on-pool)
 *   4. (if staking mode) swap treasury SOL → basket tokens → deposit_rewards
 *      (else) legacy path: airdrop directly to INDEX_MINT holders by tenure weight
 *
 * The resulting snapshot (config.POBINDEX_DATA_JSON) is what the UI reads.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { logEvent, formatSol } = require('./utils');
const { fetchPrintrSolanaCandidates, resolvePrintrHttp } = require('./printr');
const { selectTopCandidates } = require('./scoring');
const { getHolders } = require('./holders');
const { TenureDb } = require('./tenure');
const {
  calculateRewardsByWeight,
  executeTokenGroupDistribution,
  executeSolDistribution,
} = require('./distribute');
const { resolveStakingConfig, fetchPoolStateForDashboard } = require('./stake-distribute');
const { runClaimAndSweep } = require('./claim-and-sweep');
const {
  loadCurrentBasket,
  isStale,
  minutesUntilRefresh,
  refreshBasket,
  basketRefreshIntervalMin,
} = require('./basket');
const { runSpendCycle } = require('./spend-cycle');
const {
  appendSpendCycle,
  aggregateFeesSwept,
  sweptInLastDays,
  basketTimeline,
  recentSwapsByMint,
} = require('./spend-history');

const MIN_DISTRIBUTE_LAMPORTS = Math.round(
  parseFloat(process.env.MIN_DISTRIBUTE_SOL || '0.02') * 1e9
);

function buildUiTokens(selected) {
  return selected.map((t, i) => {
    const mcap = t.mcapUsd || 0;
    const fmt =
      mcap >= 1e6
        ? `$${(mcap / 1e6).toFixed(2)}M`
        : mcap >= 1e3
          ? `$${(mcap / 1e3).toFixed(0)}K`
          : `$${mcap.toFixed(0)}`;
    return {
      id: t.mint,
      mint: t.mint,
      name: t.name,
      symbol: t.symbol,
      chain: 'Solana',
      mcap,
      mcapFmt: fmt,
      change24h: Math.round((t.priceChange24h || 0) * 10) / 10,
      stakedPct: t.stakedPct != null && !Number.isNaN(t.stakedPct) ? t.stakedPct : null,
      avgLock: null,
      feeYield: null,
      pobScore: t.pobScore,
      holders: null,
      vol24h: t.volume24hUsd || 0,
      graduated: (t.liquidityUsd || 0) > 25_000,
      desc: (t.description && String(t.description).slice(0, 280)) ||
        `Printr Solana · ${t.enrichedBy || 'unknown'} metrics`,
      imageUrl: t.imageUrl || null,
      mult: null,
      enrichedBy: t.enrichedBy,
      rank: i + 1,
    };
  });
}

function writeDataJson(payload) {
  const outPath = config.POBINDEX_DATA_JSON;
  const dir = path.dirname(outPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
  logEvent('info', 'Wrote POB index data JSON', { path: outPath });
}

/**
 * Build the dashboard-only fields (pool state, lifetime fees swept, weekly
 * yield, basket timeline, per-token recent swap log). Wrapped in a single
 * try/catch because none of this is on the hot path — if any piece fails
 * we just omit it.
 */
async function buildDashboardExtras() {
  const extras = {};
  try {
    extras.pool = await fetchPoolStateForDashboard();
  } catch (e) {
    logEvent('warn', 'dashboard: pool state unavailable', { error: e.message });
    extras.pool = null;
  }
  try {
    extras.feesSwept = aggregateFeesSwept();
  } catch (e) {
    extras.feesSwept = null;
  }
  try {
    extras.feesSwept7d = sweptInLastDays(7);
  } catch (e) {
    extras.feesSwept7d = null;
  }
  try {
    extras.basketHistory = basketTimeline({ limit: 24 });
  } catch (e) {
    extras.basketHistory = [];
  }
  try {
    extras.recentSwaps = recentSwapsByMint({ perMintLimit: 8 });
  } catch (e) {
    extras.recentSwaps = {};
  }
  return extras;
}

/**
 * @param {{ dryRun?: boolean, discoverOnly?: boolean, forceBasketRefresh?: boolean }} opts
 */
async function runCycle(opts = {}) {
  const dryRun = !!opts.dryRun;
  const discoverOnly = !!opts.discoverOnly;
  const forceBasketRefresh = !!opts.forceBasketRefresh;

  const printrHttp = resolvePrintrHttp();
  const candidates = await fetchPrintrSolanaCandidates();
  const { selected, pool, stats } = await selectTopCandidates(candidates);

  const snapshot = {
    updatedAt: new Date().toISOString(),
    sources: {
      printrApiBase: printrHttp.baseUrl || null,
      printrAuth: printrHttp.hasAuth ? 'bearer' : 'none',
      discovery: process.env.PRINTR_DISCOVERY_IDS ? 'env_ids' : 'allowlist',
      dexAutoDiscover: process.env.PRINTR_AUTO_DISCOVER || 'merge',
      onchainDiscover:
        (process.env.PRINTR_ONCHAIN_DISCOVER || 'on').toLowerCase() === '0' ? 'off' : 'on',
      dexSearchQueries: process.env.PRINTR_DEX_SEARCH_QUERIES || 'printr',
      openApi: 'printr-api.json',
      candidates: 'printr+dex+onchain',
      metricsNote:
        'Pool: allowlist/ids + DexScreener search + on-chain Printr program txs ' +
        '(T8Hs…print). Every candidate validated via Printr GET /tokens/{id}; ' +
        'mcap/volume from DexScreener. Stake % = share of supply in the top-20 SPL ' +
        'holders whose account authority is the Printr program (custody/POB proxy).',
    },
    selectionStats: stats,
    tokens: buildUiTokens(selected),
    poolSize: pool.length,
  };

  if (discoverOnly) {
    snapshot.mode = 'discover_only';
    Object.assign(snapshot, await buildDashboardExtras());
    writeDataJson(snapshot);
    return { snapshot, distributed: false };
  }

  const treasury = config.parsePrivateKey(config.requireEnv('TREASURY_PRIVATE_KEY'));
  const stakingCfg = resolveStakingConfig();
  const INDEX_MINT = process.env.INDEX_MINT;
  const treasuryAddr = treasury.publicKey.toBase58();

  // 1) Claim + sweep
  const { claim, sweep } = await runClaimAndSweep({ treasuryPubkey: treasury.publicKey });
  snapshot.creatorClaim = claim;
  snapshot.creatorSweep = sweep;

  // 2) Refresh basket if stale (or always if staking mode + forceBasketRefresh).
  let basket = loadCurrentBasket();
  if (stakingCfg.enabled && (forceBasketRefresh || isStale(basket))) {
    const admin = process.env.ADMIN_PRIVATE_KEY
      ? config.parsePrivateKey(process.env.ADMIN_PRIVATE_KEY)
      : treasury;
    basket = await refreshBasket({ adminKeypair: admin, dryRun });
  }
  snapshot.basket = basket
    ? {
      version: basket.version,
      createdAt: basket.createdAt,
      refreshIntervalMin: basket.refreshIntervalMin,
      minutesUntilRefresh: minutesUntilRefresh(basket),
      entries: basket.entries,
      pinned: basket.pinned,
      newcomers: basket.newcomers,
      dropped: basket.dropped,
    }
    : null;

  let weighted = [];
  if (stakingCfg.enabled) {
    snapshot.indexMint = INDEX_MINT || null;
    snapshot.holderCount = null;
    snapshot.totalHolderBalance = null;
  } else {
    if (!INDEX_MINT) {
      throw new Error('Missing required environment variable: INDEX_MINT (required when POB_STAKE_DISTRIBUTE=0)');
    }
    const { holders, totalBalance } = await getHolders({
      mint: INDEX_MINT,
      excludeWallet: treasuryAddr,
      minBalance: config.MIN_HOLDER_BALANCE,
    });
    snapshot.indexMint = INDEX_MINT;
    snapshot.holderCount = holders.length;
    snapshot.totalHolderBalance = totalBalance.toString();
    if (holders.length === 0) {
      snapshot.warning = 'No qualifying index holders';
      writeDataJson(snapshot);
      return { snapshot, distributed: false };
    }
    const tenure = new TenureDb(config.TENURE_DB_PATH);
    try {
      weighted = tenure.applyTenure(holders);
    } finally {
      tenure.close();
    }
    if (weighted.length === 0) {
      snapshot.warning = 'No holders after tenure weighting';
      writeDataJson(snapshot);
      return { snapshot, distributed: false };
    }
  }

  if (selected.length === 0) {
    snapshot.warning = 'No tokens passed selection filters — widen POB_MIN_* or add allowlist mints';
    writeDataJson(snapshot);
    return { snapshot, distributed: false };
  }

  snapshot.dryRun = dryRun;
  snapshot.stakingEnabled = !!stakingCfg.enabled;
  snapshot.stakingPool = stakingCfg.pool ? stakingCfg.pool.toBase58() : null;
  snapshot.stakeProgramId = stakingCfg.programId ? stakingCfg.programId.toBase58() : null;
  snapshot.stakeMintAddress = stakingCfg.stakeMint ? stakingCfg.stakeMint.toBase58() : null;

  Object.assign(snapshot, await buildDashboardExtras());
  writeDataJson(snapshot);

  if (dryRun) {
    logEvent('info', 'Dry run — no swaps or transfers');
    return { snapshot, distributed: false };
  }

  // 3a) Staking mode — use new basket + spend-cycle pipeline.
  if (stakingCfg.enabled) {
    const spend = await runSpendCycle({ treasury, dryRun });
    snapshot.poolDistribution = spend;
    snapshot.lastCycleAt = new Date().toISOString();
    snapshot.mode = 'stake_rewards';

    // Persist this cycle for history + dashboard aggregation.
    try { appendSpendCycle(spend); } catch (e) {
      logEvent('warn', 'appendSpendCycle failed', { error: e.message });
    }

    // Re-compute dashboard extras now that history has grown.
    Object.assign(snapshot, await buildDashboardExtras());
    writeDataJson(snapshot);
    return { snapshot, distributed: !spend.skipped, spend };
  }

  // 3b) Legacy mode — airdrop directly to INDEX_MINT holders by tenure weight.
  const bal = await config.connection.getBalance(treasury.publicKey);
  const available = Math.max(0, bal - config.SOL_RESERVE_LAMPORTS);
  const distLamports = Math.floor((available * config.DIST_PCT) / 100);

  snapshot.treasuryBalanceLamports = bal;
  snapshot.availableLamports = available;
  snapshot.distributableLamports = distLamports;

  if (distLamports < MIN_DISTRIBUTE_LAMPORTS) {
    snapshot.warning = `Below MIN_DISTRIBUTE_SOL threshold (${formatSol(distLamports)})`;
    writeDataJson(snapshot);
    return { snapshot, distributed: false };
  }

  const scoreSum = Math.max(1, selected.reduce((s, t) => s + (t.pobScore || 1), 0));
  const mintBudgets = selected.map((t) => ({
    token: t,
    lamports: Math.floor((distLamports * (t.pobScore || 1)) / scoreSum),
  }));
  snapshot.mintBudgets = mintBudgets.map(({ token, lamports }) => ({
    mint: token.mint,
    symbol: token.symbol,
    lamports,
    sol: lamports / 1e9,
  }));
  writeDataJson(snapshot);

  const cycleResults = [];
  for (const { token, lamports } of mintBudgets) {
    if (lamports < MIN_DISTRIBUTE_LAMPORTS) {
      cycleResults.push({ mint: token.mint, symbol: token.symbol, skipped: true, reason: 'budget_below_min' });
      continue;
    }
    const label = `POB:${token.symbol}`;
    const qualified = calculateRewardsByWeight(
      weighted.map((h) => ({ address: h.address, balance: h.balance, rewardWeight: h.rewardWeight })),
      lamports,
    );
    if (qualified.length === 0) {
      cycleResults.push({ mint: token.mint, symbol: token.symbol, skipped: true, reason: 'no_qualified_holders' });
      continue;
    }
    const result = await executeTokenGroupDistribution(treasury, token.mint, qualified, label, true, {});
    const burned = result.burnedAtaHolders || [];
    if (burned.length > 0) {
      await executeSolDistribution(treasury, burned, `${label}-sol-fallback`);
    }
    cycleResults.push({
      mint: token.mint, symbol: token.symbol,
      successCount: result.successCount, failCount: result.failCount,
      distributedLamports: result.distributedLamports,
    });
  }

  snapshot.lastCycleAt = new Date().toISOString();
  snapshot.lastCycleResults = cycleResults;
  writeDataJson(snapshot);
  return { snapshot, distributed: true, cycleResults };
}

module.exports = { runCycle, writeDataJson, buildUiTokens };
