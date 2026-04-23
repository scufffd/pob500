'use strict';

/**
 * Spend-cycle history — every time `runSpendCycle` completes a (non-skipped)
 * run we drop the result into `data/spend-history/{iso}.json`. The dashboard
 * uses these files to build:
 *   • lifetime "fees swept" counters
 *   • rolling weekly yield (for APR)
 *   • basket history timeline (each rebalance + what it actually paid out)
 *   • per-token recent-swap drawer
 *
 * These files are append-only and safe to archive/rotate. Reading never
 * mutates state.
 */

const fs = require('fs');
const path = require('path');
const { logEvent } = require('./utils');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SPEND_DIR = path.join(DATA_DIR, 'spend-history');
const BASKET_HISTORY_DIR = path.join(DATA_DIR, 'basket-history');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeJsonRead(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * Persist a spend-cycle result. Accepts whatever `runSpendCycle` returned; we
 * only write cycles that actually *did* something (skipped/dry-run are not
 * useful for the dashboard).
 *
 * @param {object} cycle
 */
function appendSpendCycle(cycle) {
  if (!cycle || cycle.skipped || cycle.dryRun) return null;
  if (!Array.isArray(cycle.swaps) || cycle.swaps.length === 0) return null;

  ensureDir(SPEND_DIR);
  const ts = cycle.completedAt || new Date().toISOString();
  const safeTs = ts.replace(/[:.]/g, '-');
  const fname = `${safeTs}.json`;
  const full = path.join(SPEND_DIR, fname);
  const payload = {
    completedAt: ts,
    basketVersion: cycle.basketVersion ?? null,
    treasuryBalanceSol: cycle.treasuryBalanceSol ?? null,
    distributableSol: cycle.distributableSol ?? null,
    budgets: cycle.budgets || [],
    swaps: cycle.swaps || [],
    deposit: cycle.deposit || { deposited: [], skipped: [] },
  };
  try {
    const tmp = `${full}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, full);
  } catch (e) {
    logEvent('warn', 'spend-history write failed', { error: e.message, fname });
    return null;
  }
  return { path: full };
}

/**
 * Load spend cycles, newest first. Optionally filter by a `since` cutoff
 * (ms-since-epoch) and/or limit to the last N entries.
 */
function loadSpendCycles({ sinceMs = 0, limit = null } = {}) {
  if (!fs.existsSync(SPEND_DIR)) return [];
  const files = fs.readdirSync(SPEND_DIR).filter((f) => f.endsWith('.json'));
  const parsed = [];
  for (const f of files) {
    const data = safeJsonRead(path.join(SPEND_DIR, f));
    if (!data) continue;
    const ms = Date.parse(data.completedAt || '') || 0;
    if (ms < sinceMs) continue;
    parsed.push({ ...data, _ms: ms });
  }
  parsed.sort((a, b) => b._ms - a._ms);
  const sliced = limit ? parsed.slice(0, limit) : parsed;
  return sliced.map((x) => {
    const { _ms, ...rest } = x;
    return rest;
  });
}

/**
 * Load basket snapshots (versioned) — newest first, optionally limited.
 */
function loadBasketHistory({ limit = 24 } = {}) {
  if (!fs.existsSync(BASKET_HISTORY_DIR)) return [];
  const files = fs
    .readdirSync(BASKET_HISTORY_DIR)
    .filter((f) => /^v\d+\.json$/.test(f))
    .sort((a, b) => {
      const na = parseInt(a.match(/v(\d+)/)[1], 10);
      const nb = parseInt(b.match(/v(\d+)/)[1], 10);
      return nb - na;
    })
    .slice(0, limit);
  const out = [];
  for (const f of files) {
    const data = safeJsonRead(path.join(BASKET_HISTORY_DIR, f));
    if (data) out.push(data);
  }
  return out;
}

/**
 * Lifetime totals: total SOL swept, number of cycles, first/last cycle
 * timestamps, total deposits by reward mint.
 */
function aggregateFeesSwept() {
  const cycles = loadSpendCycles();
  let totalLamports = 0n;
  let totalCycles = 0;
  let firstAt = null;
  let lastAt = null;
  const perMint = {};

  for (const c of cycles) {
    let cycleLamports = 0n;
    for (const s of c.swaps || []) {
      if (s.error || !s.lamports) continue;
      cycleLamports += BigInt(s.lamports);
      const mintKey = s.mint;
      if (!perMint[mintKey]) perMint[mintKey] = { mint: mintKey, symbol: s.symbol || null, lamports: 0n, cycles: 0 };
      perMint[mintKey].lamports += BigInt(s.lamports);
      perMint[mintKey].cycles += 1;
    }
    if (cycleLamports > 0n) {
      totalLamports += cycleLamports;
      totalCycles += 1;
      if (!firstAt || c.completedAt < firstAt) firstAt = c.completedAt;
      if (!lastAt || c.completedAt > lastAt) lastAt = c.completedAt;
    }
  }

  const perMintArr = Object.values(perMint).map((x) => ({
    mint: x.mint,
    symbol: x.symbol,
    sol: Number(x.lamports) / 1e9,
    cycles: x.cycles,
  }));
  perMintArr.sort((a, b) => b.sol - a.sol);

  return {
    totalSol: Number(totalLamports) / 1e9,
    totalCycles,
    firstAt,
    lastAt,
    perMint: perMintArr,
  };
}

/**
 * SOL swept in the last N days (used for yield/APR display).
 */
function sweptInLastDays(days = 7) {
  const since = Date.now() - days * 86_400_000;
  const cycles = loadSpendCycles({ sinceMs: since });
  let lamports = 0n;
  for (const c of cycles) {
    for (const s of c.swaps || []) {
      if (s.error || !s.lamports) continue;
      lamports += BigInt(s.lamports);
    }
  }
  return {
    days,
    sol: Number(lamports) / 1e9,
    cycles: cycles.length,
  };
}

/**
 * Per-mint recent swap log. Returns a map `mint → [{ ts, sol, symbol, signature, basketVersion }]`
 * newest first, up to `perMintLimit` each.
 */
function recentSwapsByMint({ perMintLimit = 8, totalCycleLimit = 200 } = {}) {
  const cycles = loadSpendCycles({ limit: totalCycleLimit });
  const byMint = {};
  for (const c of cycles) {
    for (const s of c.swaps || []) {
      if (s.error) continue;
      const m = s.mint;
      if (!byMint[m]) byMint[m] = [];
      if (byMint[m].length >= perMintLimit) continue;
      // Match deposit signature (same mint) if present.
      const dep = (c.deposit && Array.isArray(c.deposit.deposited))
        ? c.deposit.deposited.find((d) => d.mint === m)
        : null;
      byMint[m].push({
        ts: c.completedAt,
        basketVersion: c.basketVersion ?? null,
        symbol: s.symbol || null,
        sol: (s.lamports || 0) / 1e9,
        swappedRaw: s.swappedRaw || null,
        depositSignature: dep ? dep.signature : null,
      });
    }
  }
  return byMint;
}

/**
 * Timeline of basket rebalances paired with what each one actually paid out.
 * Returns entries newest first.
 */
function basketTimeline({ limit = 24 } = {}) {
  const baskets = loadBasketHistory({ limit });
  // Load the spend cycles window that covers the oldest basket in our list.
  const oldest = baskets[baskets.length - 1];
  const oldestMs = oldest ? Date.parse(oldest.createdAt) - 1 : 0;
  const cycles = loadSpendCycles({ sinceMs: oldestMs });

  return baskets.map((b) => {
    // Find the cycles that ran against this basket.version.
    const cyclesForBasket = cycles.filter((c) => c.basketVersion === b.version);
    // Sum SOL spent across them.
    let sol = 0;
    const mintTotals = {};
    for (const c of cyclesForBasket) {
      for (const s of c.swaps || []) {
        if (s.error || !s.lamports) continue;
        sol += (s.lamports || 0) / 1e9;
        if (!mintTotals[s.mint]) mintTotals[s.mint] = { mint: s.mint, symbol: s.symbol, sol: 0 };
        mintTotals[s.mint].sol += (s.lamports || 0) / 1e9;
      }
    }
    const perMint = Object.values(mintTotals).sort((a, b) => b.sol - a.sol);

    return {
      version: b.version,
      createdAt: b.createdAt,
      entries: (b.entries || []).map((e) => ({
        mint: e.mint,
        symbol: e.symbol,
        name: e.name,
        pobScore: e.pobScore,
        weight: e.weight,
        pinned: !!e.pinned,
      })),
      pinned: b.pinned || [],
      newcomers: b.newcomers || [],
      dropped: b.dropped || [],
      paidOut: {
        sol,
        cycles: cyclesForBasket.length,
        perMint,
      },
    };
  });
}

module.exports = {
  SPEND_DIR,
  BASKET_HISTORY_DIR,
  appendSpendCycle,
  loadSpendCycles,
  loadBasketHistory,
  aggregateFeesSwept,
  sweptInLastDays,
  recentSwapsByMint,
  basketTimeline,
};
