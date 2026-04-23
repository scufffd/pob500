'use strict';

/**
 * Solana-mint seed collector for Printr token discovery.
 *
 * Printr's partner API has no list endpoint — we cast a wide net across
 * DexScreener + a curated bootstrap list of known Printr blue-chip mints,
 * then validate every candidate against /tokens/{caip10} in printr.js.
 * Sources here favour recall over precision (most seeds will be rejected
 * by the Printr validator and that is fine — only validated tokens ship
 * to the dashboard).
 *
 * Env (all optional):
 *   PRINTR_DEX_SEARCH_QUERIES   — comma list, overrides DEFAULT_SEARCH_QUERIES
 *   PRINTR_DEX_SCREENER_DEX_ID  — filter to one dexId (e.g. meteora) across search results
 *   PRINTR_DEX_DISCOVER_CAP     — max unique Solana mints per cycle (default 160)
 *   PRINTR_DEX_PER_QUERY_CAP    — max pairs pulled per search query (default 30)
 *   PRINTR_DEX_USE_PROFILES     — "1" | "0" — include token-profiles feed (default 1)
 *   PRINTR_DEX_USE_BOOSTS       — "1" | "0" — include token-boosts feed (default 1)
 *   PRINTR_BOOTSTRAP_MINTS      — extra comma-separated Solana mints to always probe
 */

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const { logEvent, withTimeout, sleep } = require('./utils');

// Default DexScreener search terms. Printr tokens often vanity-suffix with
// `brrr`; blue chips like BELIEF and fat choi need explicit queries since
// DexScreener search matches on symbol/name, not mint address.
const DEFAULT_SEARCH_QUERIES = [
  'printr',
  'brrr',
  'belief',
  'fat choi',
  '发财',
  'printrbot',
  'masterprintr',
  'meteoradbc',
  'dyn2',
];

// Curated list of well-known Printr Solana mints that aren't reliably
// surfaced by DexScreener search. Every entry is still validated against
// Printr's /tokens/{caip10} — if a mint stops being a Printr token it will
// silently fall out of the pool.
const KNOWN_PRINTR_MINTS = [
  '57dYAUq7Y4hiCSdAB7iBDg4gcYFq7HeUaEs3XnNkbrrr', // fat choi (发财)
  '29CWsqH84TykHDDwA6DtETUtXQPuKbVgKCmxtkBsbrrr', // BELIEF
  '91ACiGss1ZiszniTvqhGTqJPfk7YBSuLjrTTZcfPU7PH', // PrintrBot Ultra (BRRR)
  '9RFqt1pNCQFb6fDVCFTRXfoGQTL5hHGvP9U7VzFCbrrr', // Masterprintr (FED)
  'EdNpbmLNx8yA9F278V8bZueaNJmcxMNQbxWVnvr3brrr', // Cult of Printr
  'BdqNyg2k9TrYUGjadxMRjxv7xn1pPYpfeDXj5wSnbrrr', // roi
];

function looksLikeSolanaMintBase58(s) {
  if (!s || typeof s !== 'string' || s.includes(':')) return false;
  return /^[1-9A-HJ-NP-Za-km-z]{32,48}$/.test(s);
}

function truthyFlag(v, fallback = true) {
  if (v == null || v === '') return fallback;
  const s = String(v).toLowerCase();
  return !(s === '0' || s === 'off' || s === 'false' || s === 'no');
}

async function dsGetJson(url, label) {
  const res = await withTimeout(fetch(url, { headers: { Accept: 'application/json' } }), 18_000, label);
  if (!res.ok) {
    logEvent('warn', 'DexScreener HTTP error', { label, status: res.status });
    return null;
  }
  try {
    return await res.json();
  } catch (e) {
    logEvent('warn', 'DexScreener JSON parse failed', { label, error: e.message });
    return null;
  }
}

/**
 * @returns {Promise<Array<{ mint: string, symbol?: string, name?: string, volumeH24?: number, priceChangeH24?: number, dexId?: string, source: string }>>}
 */
async function fetchDexScreenerSolanaMintSeeds() {
  const queries = (process.env.PRINTR_DEX_SEARCH_QUERIES || DEFAULT_SEARCH_QUERIES.join(','))
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const dexIdFilter = (process.env.PRINTR_DEX_SCREENER_DEX_ID || '').trim();
  const totalCap = Math.max(1, parseInt(process.env.PRINTR_DEX_DISCOVER_CAP || '160', 10));
  const perQueryCap = Math.max(1, parseInt(process.env.PRINTR_DEX_PER_QUERY_CAP || '30', 10));
  const useProfiles = truthyFlag(process.env.PRINTR_DEX_USE_PROFILES, true);
  const useBoosts = truthyFlag(process.env.PRINTR_DEX_USE_BOOSTS, true);

  const mintMap = new Map();

  const add = (addr, extra, source) => {
    if (!addr || !looksLikeSolanaMintBase58(addr) || mintMap.has(addr)) return false;
    if (mintMap.size >= totalCap) return false;
    mintMap.set(addr, { mint: addr, source, ...extra });
    return true;
  };

  // 0) Curated bootstrap — blue-chip Printr mints that DexScreener search
  //    does not reliably surface by symbol/name.
  const bootstrapEnv = (process.env.PRINTR_BOOTSTRAP_MINTS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  for (const addr of [...KNOWN_PRINTR_MINTS, ...bootstrapEnv]) {
    add(addr, {}, 'bootstrap');
  }

  // 1) Per-query search endpoint (most useful when we know relevant keywords).
  for (const q of queries) {
    if (mintMap.size >= totalCap) break;
    const body = await dsGetJson(
      `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,
      `search:${q.slice(0, 24)}`
    );
    if (!body) {
      await sleep(280);
      continue;
    }
    const pairs = body.pairs || [];
    let taken = 0;
    for (const p of pairs) {
      if (mintMap.size >= totalCap) break;
      if (taken >= perQueryCap) break;
      if (p.chainId !== 'solana') continue;
      if (dexIdFilter && p.dexId !== dexIdFilter) continue;
      const addr = p.baseToken?.address;
      const added = add(addr, {
        symbol: String(p.baseToken?.symbol || '').slice(0, 32) || undefined,
        name: String(p.baseToken?.name || '').slice(0, 120) || undefined,
        volumeH24: typeof p.volume?.h24 === 'number' ? p.volume.h24 : undefined,
        priceChangeH24: typeof p.priceChange?.h24 === 'number' ? p.priceChange.h24 : undefined,
        dexId: p.dexId,
      }, `dex-search:${q}`);
      if (added) taken++;
    }
    await sleep(280);
  }

  // 2) Latest token profiles (new-to-DexScreener feed) — Solana only.
  if (useProfiles && mintMap.size < totalCap) {
    const body = await dsGetJson(
      'https://api.dexscreener.com/token-profiles/latest/v1',
      'token-profiles'
    );
    if (body) {
      const arr = Array.isArray(body) ? body : body.data || [];
      for (const row of arr) {
        if (mintMap.size >= totalCap) break;
        if (row?.chainId !== 'solana') continue;
        add(row.tokenAddress, {}, 'dex-profiles');
      }
    }
    await sleep(280);
  }

  // 3) Latest + top boosts — Solana only.
  if (useBoosts && mintMap.size < totalCap) {
    for (const url of [
      'https://api.dexscreener.com/token-boosts/latest/v1',
      'https://api.dexscreener.com/token-boosts/top/v1',
    ]) {
      if (mintMap.size >= totalCap) break;
      const body = await dsGetJson(url, `boosts:${url.includes('top') ? 'top' : 'latest'}`);
      if (!body) {
        await sleep(280);
        continue;
      }
      const arr = Array.isArray(body) ? body : body.data || [];
      for (const row of arr) {
        if (mintMap.size >= totalCap) break;
        if (row?.chainId !== 'solana') continue;
        add(row.tokenAddress, {}, 'dex-boosts');
      }
      await sleep(280);
    }
  }

  const arr = [...mintMap.values()];
  logEvent('info', 'DexScreener Solana mint seeds collected', {
    count: arr.length,
    queries: queries.length,
    dexIdFilter: dexIdFilter || '(none)',
    useProfiles,
    useBoosts,
  });
  return arr;
}

module.exports = {
  fetchDexScreenerSolanaMintSeeds,
  looksLikeSolanaMintBase58,
};
