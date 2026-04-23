'use strict';

/**
 * Airdrop basket — the set of reward mints the worker is *currently buying*
 * with claimed creator fees each cycle.
 *
 *   basket.entries   ⊆   pool.reward_mints   (pool grows monotonically;
 *                                              basket turns over each refresh)
 *
 * A basket is:
 *   - versioned (monotonically increasing integer)
 *   - persisted to data/basket-current.json (atomic rename)
 *   - archived to data/basket-history/v{N}.json on every bump
 *   - read by the UI + the spend-cycle
 *   - refreshed every BASKET_REFRESH_MIN (default 60) — see scripts/run-loop.js
 *
 * On refresh, any mint newly entering the basket has `add_reward_mint` called
 * on the staking pool so the on-chain reward-vault exists before we try to
 * deposit into it. Mints that roll OUT of the basket stay registered on-pool
 * forever — we just stop buying more of them (their already-deposited rewards
 * remain fully claimable by stakers).
 */

const fs = require('fs');
const path = require('path');
const { PublicKey } = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} = require('@solana/spl-token');

const config = require('./config');
const { logEvent } = require('./utils');
const { fetchPrintrSolanaCandidates } = require('./printr');
const { selectTopCandidates } = require('./scoring');
const { ensureRewardMintRegistered } = require('./ensure-reward-mint');

const BASKET_DIR = path.join(__dirname, '..', 'data');
const BASKET_FILE = path.join(BASKET_DIR, 'basket-current.json');
const HISTORY_DIR = path.join(BASKET_DIR, 'basket-history');

function ensureDirs() {
  if (!fs.existsSync(BASKET_DIR)) fs.mkdirSync(BASKET_DIR, { recursive: true });
  if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

function loadCurrentBasket() {
  try {
    if (!fs.existsSync(BASKET_FILE)) return null;
    return JSON.parse(fs.readFileSync(BASKET_FILE, 'utf8'));
  } catch (e) {
    logEvent('warn', 'Basket file unreadable; treating as empty', { error: e.message });
    return null;
  }
}

function writeBasket(basket) {
  ensureDirs();
  const tmp = `${BASKET_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(basket, null, 2), 'utf8');
  fs.renameSync(tmp, BASKET_FILE);
  const hist = path.join(HISTORY_DIR, `v${basket.version}.json`);
  fs.writeFileSync(hist, JSON.stringify(basket, null, 2), 'utf8');
}

function basketRefreshIntervalMin() {
  return Math.max(1, parseInt(process.env.BASKET_REFRESH_MIN || '60', 10));
}

function basketSize() {
  return Math.max(1, parseInt(process.env.BASKET_SIZE || process.env.POB_TOP_N || '5', 10));
}

function pinnedMints() {
  const raw = process.env.BASKET_PINNED_MINTS || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isStale(basket, intervalMin = basketRefreshIntervalMin()) {
  if (!basket || !basket.createdAt) return true;
  const createdAtMs = Date.parse(basket.createdAt);
  if (Number.isNaN(createdAtMs)) return true;
  return Date.now() - createdAtMs >= intervalMin * 60_000;
}

function minutesUntilRefresh(basket, intervalMin = basketRefreshIntervalMin()) {
  if (!basket || !basket.createdAt) return 0;
  const createdAtMs = Date.parse(basket.createdAt);
  const next = createdAtMs + intervalMin * 60_000;
  return Math.max(0, Math.round((next - Date.now()) / 60_000));
}

async function detectTokenProgram(connection, mint) {
  try {
    const info = await connection.getAccountInfo(mint);
    if (!info) return null;
    if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return 'Token-2022';
    if (info.owner.equals(TOKEN_PROGRAM_ID)) return 'Legacy SPL';
    return null;
  } catch {
    return null;
  }
}

function weightFromScore(score) {
  // Linear weight derived from pobScore (clamped to ≥1 so nothing is zero-weighted).
  return Math.max(1, Math.round(score || 1));
}

function normalizeWeights(entries) {
  const sum = entries.reduce((s, e) => s + (e.weightRaw || 1), 0) || 1;
  return entries.map((e) => ({ ...e, weight: Number(((e.weightRaw || 1) / sum).toFixed(4)) }));
}

/**
 * Compute the next basket *without* writing it or touching on-chain state.
 * Used internally by `refreshBasket` and by dry-run tooling.
 */
async function computeNextBasket() {
  const size = basketSize();
  const pins = pinnedMints();
  const candidates = await fetchPrintrSolanaCandidates();
  const { selected, pool, stats } = await selectTopCandidates(candidates, {
    topN: Math.max(size, size + pins.length), // pull extra so pins + top fill cleanly
  });

  // Build pool lookup: mint → candidate
  const byMint = new Map();
  for (const c of pool) byMint.set(c.mint, c);

  // Pins first (in order they were specified), then fill remaining slots by
  // score from `selected`, skipping anything already taken by a pin.
  const takenMints = new Set();
  const entries = [];

  for (const mint of pins) {
    const cand = byMint.get(mint);
    if (!cand) {
      logEvent('warn', 'Pinned mint has no matching Printr candidate — skipping', { mint });
      continue;
    }
    entries.push({ ...cand, pinned: true });
    takenMints.add(mint);
    if (entries.length >= size) break;
  }

  for (const cand of selected) {
    if (entries.length >= size) break;
    if (takenMints.has(cand.mint)) continue;
    entries.push({ ...cand, pinned: false });
    takenMints.add(cand.mint);
  }

  // Detect token program for each entry (used by spend cycle + on-pool register).
  for (const e of entries) {
    e.tokenProgram = await detectTokenProgram(config.connection, new PublicKey(e.mint));
  }

  const shaped = entries.map((e) => ({
    mint: e.mint,
    symbol: e.symbol,
    name: e.name,
    pobScore: e.pobScore,
    weightRaw: weightFromScore(e.pobScore),
    pinned: !!e.pinned,
    mcapUsd: e.mcapUsd || 0,
    volume24hUsd: e.volume24hUsd || 0,
    liquidityUsd: e.liquidityUsd || 0,
    priceChange24h: e.priceChange24h || 0,
    stakedPct: e.stakedPct ?? null,
    tokenProgram: e.tokenProgram || null,
    registered: false, // filled in by refreshBasket after on-pool checks
  }));

  return {
    entries: normalizeWeights(shaped),
    pins,
    stats: { ...stats, pinnedCount: pins.length, basketSize: size },
  };
}

/**
 * Persist the "no staking pool configured yet" happy-path: basket still
 * refreshes (so the UI can show it) but we don't attempt to register on-chain.
 */
function stakingAvailable() {
  return !!(process.env.POB_STAKE_PROGRAM_ID && process.env.POB_STAKE_MINT);
}

/**
 * @param {object} opts
 * @param {import('@solana/web3.js').Keypair} [opts.adminKeypair] signer for add_reward_mint
 * @param {boolean} [opts.dryRun] compute + persist basket without on-chain writes
 */
async function refreshBasket(opts = {}) {
  const adminKeypair = opts.adminKeypair || null;
  const dryRun = !!opts.dryRun;

  const current = loadCurrentBasket();
  const next = await computeNextBasket();

  const prevMints = new Set((current?.entries || []).map((e) => e.mint));
  const nextMints = new Set(next.entries.map((e) => e.mint));
  const newcomers = next.entries.filter((e) => !prevMints.has(e.mint));
  const dropped = [...prevMints].filter((m) => !nextMints.has(m));

  // Register newcomers on-pool so they can receive deposit_rewards.
  // Registrations are idempotent: if the reward-mint PDA already exists we
  // skip. We also skip cleanly when staking env is not configured.
  const registrationResults = [];
  if (!dryRun && stakingAvailable() && adminKeypair) {
    for (const e of next.entries) {
      if (!e.mint) continue;
      try {
        const r = await ensureRewardMintRegistered({
          mintBase58: e.mint,
          adminKeypair,
        });
        e.registered = true;
        registrationResults.push({ mint: e.mint, ...r });
      } catch (err) {
        e.registered = false;
        registrationResults.push({ mint: e.mint, error: err.message || String(err) });
        logEvent('warn', 'Failed to register reward mint', { mint: e.mint, error: err.message });
      }
    }
  }

  const version = (current?.version || 0) + 1;
  const basket = {
    version,
    createdAt: new Date().toISOString(),
    refreshIntervalMin: basketRefreshIntervalMin(),
    basketSize: basketSize(),
    pinned: next.pins,
    entries: next.entries,
    dropped,
    newcomers: newcomers.map((e) => e.mint),
    registrationResults,
    stats: next.stats,
    dryRun,
  };

  if (!dryRun) writeBasket(basket);

  logEvent('info', 'Basket refreshed', {
    version,
    size: next.entries.length,
    newcomers: newcomers.length,
    dropped: dropped.length,
    dryRun,
  });

  return basket;
}

module.exports = {
  BASKET_FILE,
  HISTORY_DIR,
  basketRefreshIntervalMin,
  basketSize,
  pinnedMints,
  loadCurrentBasket,
  writeBasket,
  isStale,
  minutesUntilRefresh,
  detectTokenProgram,
  computeNextBasket,
  refreshBasket,
};
