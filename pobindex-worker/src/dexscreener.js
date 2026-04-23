'use strict';

/**
 * DexScreener enrichment for Solana pairs — same pattern as rewardflow claim.js
 */

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const { logEvent, withTimeout } = require('./utils');

/**
 * @param {string} mint
 * @returns {Promise<{ mcapUsd: number, volume24hUsd: number, liquidityUsd: number, priceChange24h: number, pairAddress?: string }|null>}
 */
async function enrichMintFromDexScreener(mint) {
  try {
    const res = await withTimeout(
      fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`),
      12_000,
      'DexScreener token'
    );
    if (!res.ok) return null;
    const data = await res.json();
    const pairs = (data.pairs || []).filter(p => p.chainId === 'solana');
    if (!pairs.length) return null;

    let best = pairs[0];
    let bestLiq = Number(best.liquidity?.usd || 0);
    for (const p of pairs) {
      const liq = Number(p.liquidity?.usd || 0);
      if (liq > bestLiq) {
        best = p;
        bestLiq = liq;
      }
    }

    const mcapUsd = Number(best.fdv || best.marketCap || 0) || 0;
    const volume24hUsd = Number(best.volume?.h24 || 0) || 0;
    const liquidityUsd = Number(best.liquidity?.usd || 0) || 0;
    const priceChange24h = Number(best.priceChange?.h24 || 0) || 0;

    return {
      mcapUsd,
      volume24hUsd,
      liquidityUsd,
      priceChange24h,
      pairAddress: best.pairAddress,
    };
  } catch (e) {
    logEvent('warn', 'DexScreener enrichment failed', { mint: mint.slice(0, 8), error: e.message });
    return null;
  }
}

/**
 * Fill missing metrics on a candidate from DexScreener when Printr did not supply them.
 */
async function enrichCandidate(c) {
  const needs =
    c.mcapUsd == null ||
    c.volume24hUsd == null ||
    c.liquidityUsd == null ||
    c.priceChange24h == null;
  if (!needs) return { ...c, enrichedBy: 'printr' };

  const ds = await enrichMintFromDexScreener(c.mint);
  if (!ds) return { ...c, enrichedBy: 'none' };

  return {
    ...c,
    mcapUsd: c.mcapUsd ?? ds.mcapUsd,
    volume24hUsd: c.volume24hUsd ?? ds.volume24hUsd,
    liquidityUsd: c.liquidityUsd ?? ds.liquidityUsd,
    priceChange24h: c.priceChange24h ?? ds.priceChange24h,
    pairAddress: ds.pairAddress,
    enrichedBy: 'dexscreener',
  };
}

module.exports = { enrichMintFromDexScreener, enrichCandidate };
