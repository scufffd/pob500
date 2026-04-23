'use strict';

const config = require('./config');
const { enrichCandidate } = require('./dexscreener');
const { attachStakingToCandidates } = require('./pob-staking');

const DEFAULT_STAKE_MAX = 12;

/**
 * POB score 0–100: mcap (log), 24h volume, liquidity, price change, staked %.
 * Stake is % of supply in top-20 SPL accounts whose authority is the Printr program
 * (protocol custody / POB vault proxy). See pob-staking.js.
 */
function computePobScore(c) {
  const mcap = Math.max(0, c.mcapUsd || 0);
  const vol = Math.max(0, c.volume24hUsd || 0);
  const liq = Math.max(0, c.liquidityUsd || 0);
  const chg = c.priceChange24h != null ? c.priceChange24h : 0;
  const stakeMax = Math.max(0, parseFloat(process.env.POB_STAKE_MAX_POINTS || String(DEFAULT_STAKE_MAX)));
  const scale = (100 - stakeMax) / 100;

  const mcapPts = Math.min(33 * scale, (Math.log10(1 + mcap) / Math.log10(1 + 5_000_000)) * 33 * scale);
  const volPts = Math.min(34 * scale, (Math.log10(1 + vol) / Math.log10(1 + 2_000_000)) * 34 * scale);
  const liqPts = Math.min(20 * scale, (Math.log10(1 + liq) / Math.log10(1 + 500_000)) * 20 * scale);
  const pricePts = Math.max(0, Math.min(13 * scale, ((chg + 30) / 80) * 13 * scale));
  const stakeRaw = c.stakedPct != null ? Math.max(0, Math.min(100, c.stakedPct)) : 0;
  const stakePts = Math.min(stakeMax, (stakeRaw / 100) * stakeMax);

  return Math.round(Math.min(100, mcapPts + volPts + liqPts + pricePts + stakePts));
}

/**
 * @param {import('./printr').PrintrCandidate[]} candidates
 * @param {object} opts
 */
async function enrichAll(candidates) {
  const out = [];
  for (const c of candidates) {
    out.push(await enrichCandidate(c));
    await new Promise(r => setTimeout(r, 120));
  }
  return out;
}

function filterByFloors(candidates, opts) {
  const minMcap = opts.minMcapUsd ?? 0;
  const minVol = opts.minVolume24hUsd ?? 0;
  const minLiq = opts.minLiquidityUsd ?? 0;
  return candidates.filter(c => {
    if ((c.mcapUsd || 0) < minMcap) return false;
    if ((c.volume24hUsd || 0) < minVol) return false;
    if ((c.liquidityUsd || 0) < minLiq) return false;
    return true;
  });
}

/**
 * Rank, attach pobScore, return top N with reasons.
 * @param {import('./printr').PrintrCandidate[]} candidates — already Solana-normalized
 */
async function selectTopCandidates(candidates, opts = {}) {
  const topN = opts.topN ?? parseInt(process.env.POB_TOP_N || '5', 10);
  const minMcapUsd = opts.minMcapUsd ?? parseFloat(process.env.POB_MIN_MCAP_USD || '50000');
  const minVolume24hUsd = opts.minVolume24hUsd ?? parseFloat(process.env.POB_MIN_VOL24H_USD || '10000');
  const minLiquidityUsd = opts.minLiquidityUsd ?? parseFloat(process.env.POB_MIN_LIQ_USD || '5000');

  const enriched = await enrichAll(candidates);
  const filtered = filterByFloors(enriched, {
    minMcapUsd: minMcapUsd,
    minVolume24hUsd: minVolume24hUsd,
    minLiquidityUsd: minLiquidityUsd,
  });

  const withStake = await attachStakingToCandidates(config.connection, filtered, {
    delayMs: parseInt(process.env.POB_STAKE_RPC_DELAY_MS || '50', 10),
  });

  const scored = withStake.map(c => ({
    ...c,
    pobScore: computePobScore(c),
  }));

  scored.sort((a, b) => b.pobScore - a.pobScore || (b.mcapUsd || 0) - (a.mcapUsd || 0));

  const selected = scored.slice(0, topN);
  return {
    selected,
    pool: scored,
    stats: {
      inputCount: candidates.length,
      enrichedCount: enriched.length,
      afterFloors: filtered.length,
      topN,
    },
  };
}

module.exports = {
  computePobScore,
  enrichAll,
  filterByFloors,
  selectTopCandidates,
};
