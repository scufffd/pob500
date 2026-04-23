'use strict';

/**
 * On-chain Printr discovery via Helius Enhanced Transactions.
 *
 * Printr's Solana program (`T8HsGYv7sMk3kTnyaRqZrbRPuntYzdh12evXBkprint`) is
 * touched by every token mint/trade. We page through its recent parsed
 * transactions and harvest the SPL mints referenced in tokenTransfers —
 * this reliably surfaces Printr tokens that DexScreener search does not
 * return (e.g. tokens whose name/symbol contains no "printr"/"brrr" term).
 *
 * Each mint still round-trips through Printr's partner API in printr.js,
 * so false positives are dropped.
 *
 * Env:
 *   HELIUS_API_KEY              — required (reuses the worker's key).
 *   PRINTR_ONCHAIN_PAGES        — number of 100-tx pages per cycle (default 5).
 *   PRINTR_ONCHAIN_CAP          — max unique mints returned per cycle (default 200).
 *   PRINTR_ONCHAIN_CURSOR_PATH  — file used to remember the newest signature we
 *                                 have processed, so subsequent runs tail new txs.
 *                                 Default: <worker>/data/onchain-cursor.json
 */

const fs = require('fs');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const { logEvent, withTimeout, sleep } = require('./utils');

const PRINTR_PROGRAM_ID = 'T8HsGYv7sMk3kTnyaRqZrbRPuntYzdh12evXBkprint';
const WSOL = 'So11111111111111111111111111111111111111112';

const WORKER_ROOT = path.join(__dirname, '..');
const DEFAULT_CURSOR_PATH = path.join(WORKER_ROOT, 'data', 'onchain-cursor.json');

function looksLikeSolanaMintBase58(s) {
  if (!s || typeof s !== 'string' || s.includes(':')) return false;
  return /^[1-9A-HJ-NP-Za-km-z]{32,48}$/.test(s);
}

function loadCursor(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function saveCursor(p, data) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    logEvent('warn', 'Failed to persist on-chain cursor', { path: p, error: e.message });
  }
}

async function fetchHeliusPage(apiKey, { before, limit = 100 }) {
  const qs = new URLSearchParams({ 'api-key': apiKey, limit: String(limit) });
  if (before) qs.set('before', before);
  const url = `https://api.helius.xyz/v0/addresses/${PRINTR_PROGRAM_ID}/transactions?${qs.toString()}`;
  const res = await withTimeout(fetch(url), 25_000, 'helius-enhanced-txs');
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Helius HTTP ${res.status}: ${body.slice(0, 180)}`);
  }
  const json = await res.json();
  if (!Array.isArray(json)) {
    throw new Error(`Helius unexpected payload: ${JSON.stringify(json).slice(0, 180)}`);
  }
  return json;
}

function collectMintsFromTx(tx, out) {
  const transfers = tx.tokenTransfers || [];
  for (const t of transfers) {
    const m = t.mint;
    if (!m || m === WSOL) continue;
    if (!looksLikeSolanaMintBase58(m)) continue;
    out.add(m);
  }
  // Also glance at accountData.tokenBalanceChanges for mints that only show up
  // as balance deltas (e.g. LP position mints, rewards vaults).
  const changes = tx.accountData || [];
  for (const ad of changes) {
    for (const tb of ad.tokenBalanceChanges || []) {
      const m = tb.mint;
      if (!m || m === WSOL) continue;
      if (!looksLikeSolanaMintBase58(m)) continue;
      out.add(m);
    }
  }
}

/**
 * @returns {Promise<{ mints: string[], newestSignature: string|null, pagesFetched: number, txCount: number }>}
 */
async function fetchPrintrOnchainMintSeeds(opts = {}) {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    logEvent('warn', 'HELIUS_API_KEY not set — on-chain discovery skipped');
    return { mints: [], newestSignature: null, pagesFetched: 0, txCount: 0 };
  }

  const maxPages = Math.max(1, parseInt(process.env.PRINTR_ONCHAIN_PAGES || opts.pages || '5', 10));
  const cap = Math.max(1, parseInt(process.env.PRINTR_ONCHAIN_CAP || opts.cap || '200', 10));
  const cursorPath = process.env.PRINTR_ONCHAIN_CURSOR_PATH || opts.cursorPath || DEFAULT_CURSOR_PATH;

  const cursor = loadCursor(cursorPath);
  const lastKnownSig = cursor.lastSignature || null;

  const found = new Set();
  let before = null;
  let newestSignature = null;
  let pagesFetched = 0;
  let txCount = 0;
  let stopEarly = false;

  for (let page = 0; page < maxPages && !stopEarly; page++) {
    let rows;
    try {
      rows = await fetchHeliusPage(apiKey, { before, limit: 100 });
    } catch (e) {
      logEvent('warn', 'Helius page fetch failed', { page, error: e.message });
      break;
    }
    pagesFetched++;
    if (!rows.length) break;

    if (page === 0) newestSignature = rows[0].signature || newestSignature;
    txCount += rows.length;

    for (const tx of rows) {
      if (lastKnownSig && tx.signature === lastKnownSig) {
        // Everything from here onwards is already known — stop paging.
        stopEarly = true;
        break;
      }
      collectMintsFromTx(tx, found);
      if (found.size >= cap) {
        stopEarly = true;
        break;
      }
    }

    before = rows[rows.length - 1].signature;
    await sleep(250);
  }

  if (newestSignature) {
    saveCursor(cursorPath, {
      lastSignature: newestSignature,
      updatedAt: new Date().toISOString(),
    });
  }

  const mints = [...found].slice(0, cap);
  logEvent('info', 'On-chain Printr mint seeds collected', {
    count: mints.length,
    pagesFetched,
    txCount,
    hadCursor: !!lastKnownSig,
    program: PRINTR_PROGRAM_ID,
  });
  return { mints, newestSignature, pagesFetched, txCount };
}

module.exports = {
  fetchPrintrOnchainMintSeeds,
  PRINTR_PROGRAM_ID,
};
