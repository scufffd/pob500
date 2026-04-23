'use strict';

/**
 * Presale support:
 *   1. Scan every inbound SOL transfer to the presale wallet, aggregate by
 *      sender, persist to `data/presale/contributions.json`.
 *   2. Derive each contributor's pro-rata slice of the POB500 presale budget.
 *   3. Record what we've already distributed so re-runs are idempotent.
 *
 * Everything here is pure logic + file I/O — the RPC-specific bits live in the
 * `scripts/presale-*.js` CLIs so this module stays easy to unit-test.
 */

const fs = require('fs');
const path = require('path');
const { PublicKey } = require('@solana/web3.js');

/** @returns {string} Absolute path to presale state dir (contributions + distributed JSON). */
function getPresaleStateDir() {
  const raw = process.env.POBINDEX_PRESALE_STATE_DIR;
  if (!raw) return path.join(__dirname, '..', 'data', 'presale');
  if (path.isAbsolute(raw)) return raw;
  return path.join(__dirname, '..', raw);
}

function contributionsPath() {
  return path.join(getPresaleStateDir(), 'contributions.json');
}

function distributedPath() {
  return path.join(getPresaleStateDir(), 'distributed.json');
}

function ensureDir() {
  const dir = getPresaleStateDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to parse ${p}: ${e.message}`);
  }
}

function writeJson(p, data) {
  ensureDir();
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function loadContributions() {
  return readJson(contributionsPath(), null);
}

function saveContributions(data) {
  const p = contributionsPath();
  writeJson(p, data);
  return p;
}

function loadDistributed() {
  return readJson(distributedPath(), { updatedAt: null, entries: {} });
}

function saveDistributed(data) {
  data.updatedAt = new Date().toISOString();
  const p = distributedPath();
  writeJson(p, data);
  return p;
}

/**
 * Resolve presale config from env. Throws if mandatory keys are missing.
 *
 * @returns {{
 *   presaleWallet: PublicKey,
 *   tokenTotal: bigint,          // raw units (mint decimals applied)
 *   lockDays: number,
 *   minLamports: bigint,         // ignore contributions below this
 *   excludeWallets: Set<string>,
 *   startTs: number|null,
 *   endTs: number|null,
 * }}
 */
function resolvePresaleConfig({ requireTokenTotal = true } = {}) {
  const walletStr = process.env.POBINDEX_PRESALE_WALLET;
  if (!walletStr) throw new Error('POBINDEX_PRESALE_WALLET is required');
  const presaleWallet = new PublicKey(walletStr);

  const totalStr = process.env.POBINDEX_PRESALE_TOKEN_TOTAL;
  let tokenTotal = 0n;
  if (totalStr) {
    tokenTotal = BigInt(totalStr.replace(/_/g, ''));
    if (tokenTotal <= 0n) throw new Error('POBINDEX_PRESALE_TOKEN_TOTAL must be > 0');
  } else if (requireTokenTotal) {
    throw new Error(
      'POBINDEX_PRESALE_TOKEN_TOTAL is required — set to the total POB500 raw units reserved for the presale (e.g. 10_000_000 * 10^decimals)',
    );
  }

  const lockDays = parseInt(process.env.POBINDEX_PRESALE_LOCK_DAYS || '7', 10);
  if (![1, 3, 7, 14, 21, 30].includes(lockDays)) {
    throw new Error(`POBINDEX_PRESALE_LOCK_DAYS must be one of 1,3,7,14,21,30 (got ${lockDays})`);
  }

  const minSol = parseFloat(process.env.POBINDEX_PRESALE_MIN_SOL || '0');
  const minLamports = BigInt(Math.round(minSol * 1e9));

  const excludeWallets = new Set(
    (process.env.POBINDEX_PRESALE_EXCLUDE || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  excludeWallets.add(presaleWallet.toBase58()); // never self-credit the presale wallet

  const startTs = process.env.POBINDEX_PRESALE_START_TS
    ? parseInt(process.env.POBINDEX_PRESALE_START_TS, 10)
    : null;
  const endTs = process.env.POBINDEX_PRESALE_END_TS
    ? parseInt(process.env.POBINDEX_PRESALE_END_TS, 10)
    : null;

  return { presaleWallet, tokenTotal, lockDays, minLamports, excludeWallets, startTs, endTs };
}

/**
 * Extract inbound native SOL transfers to `destination` from a parsed
 * transaction. Returns an array of { source, lamports }.
 *
 * We only match `system` program `transfer` / `transferWithSeed` ixs — that's
 * the call path used by wallet apps (Phantom, Solflare, web3.js
 * `SystemProgram.transfer`). We deliberately *don't* fall back to raw balance
 * deltas because those also pick up rent payments, fee deductions on the
 * sender, and ATA creation side-effects.
 */
function extractInboundTransfers(parsedTx, destinationBase58) {
  if (!parsedTx || !parsedTx.transaction || !parsedTx.meta) return [];
  if (parsedTx.meta.err) return []; // ignore failed txs
  const out = [];
  const instrs = parsedTx.transaction.message.instructions || [];
  const inner = (parsedTx.meta.innerInstructions || []).flatMap((g) => g.instructions || []);
  const all = [...instrs, ...inner];
  for (const ix of all) {
    if (!ix || ix.program !== 'system' || !ix.parsed) continue;
    const t = ix.parsed.type;
    if (t !== 'transfer' && t !== 'transferWithSeed') continue;
    const info = ix.parsed.info || {};
    if (info.destination !== destinationBase58) continue;
    const lamports = BigInt(info.lamports || 0);
    const source = info.source;
    if (!source || lamports === 0n) continue;
    out.push({ source, lamports });
  }
  return out;
}

/**
 * Aggregate a list of raw transfers (as produced by `extractInboundTransfers`
 * plus `{ signature, blockTime }` metadata) into per-wallet contributions.
 */
function aggregateContributions(rawTransfers, { excludeWallets = new Set(), minLamports = 0n } = {}) {
  const byWallet = new Map();
  for (const row of rawTransfers) {
    if (excludeWallets.has(row.source)) continue;
    if (!byWallet.has(row.source)) {
      byWallet.set(row.source, {
        wallet: row.source,
        totalLamports: 0n,
        txCount: 0,
        firstSeenAt: row.blockTime || null,
        lastSeenAt: row.blockTime || null,
        txs: [],
      });
    }
    const agg = byWallet.get(row.source);
    agg.totalLamports += row.lamports;
    agg.txCount += 1;
    if (row.blockTime) {
      if (!agg.firstSeenAt || row.blockTime < agg.firstSeenAt) agg.firstSeenAt = row.blockTime;
      if (!agg.lastSeenAt || row.blockTime > agg.lastSeenAt) agg.lastSeenAt = row.blockTime;
    }
    agg.txs.push({ signature: row.signature, lamports: row.lamports.toString(), blockTime: row.blockTime });
  }

  const rows = [];
  for (const agg of byWallet.values()) {
    if (agg.totalLamports < minLamports) continue;
    rows.push({
      ...agg,
      totalLamports: agg.totalLamports.toString(),
    });
  }
  rows.sort((a, b) => {
    const diff = BigInt(b.totalLamports) - BigInt(a.totalLamports);
    if (diff > 0n) return 1;
    if (diff < 0n) return -1;
    return 0;
  });
  return rows;
}

/**
 * Allocate the fixed token pool across contributors pro-rata to lamports.
 * Uses integer math with remainder redistribution so rounding dust goes to
 * the largest contributors (never creates tokens out of thin air).
 *
 * @param {Array<{wallet:string,totalLamports:string}>} contributions
 * @param {bigint} tokenTotal  raw mint units to distribute
 * @returns {Array<{wallet:string,lamports:bigint,tokens:bigint,shareBps:number}>}
 */
function allocateAllocations(contributions, tokenTotal) {
  if (contributions.length === 0) return [];
  let sum = 0n;
  const rows = contributions.map((c) => {
    const lamports = BigInt(c.totalLamports);
    sum += lamports;
    return { wallet: c.wallet, lamports, tokens: 0n, shareBps: 0 };
  });
  if (sum === 0n) return rows;

  // Integer floor allocation.
  let allocated = 0n;
  for (const r of rows) {
    r.tokens = (r.lamports * tokenTotal) / sum;
    r.shareBps = Number((r.lamports * 10_000n) / sum);
    allocated += r.tokens;
  }
  // Distribute the (small) remainder to the biggest contributors so totals
  // match `tokenTotal` exactly.
  let remainder = tokenTotal - allocated;
  const sorted = [...rows].sort((a, b) => {
    if (b.lamports === a.lamports) return 0;
    return b.lamports > a.lamports ? 1 : -1;
  });
  let i = 0;
  while (remainder > 0n && i < sorted.length) {
    sorted[i].tokens += 1n;
    remainder -= 1n;
    i = (i + 1) % sorted.length;
  }
  return rows;
}

/**
 * Compute the dev-buy pro-rata plan.
 *
 * Flow (see `scripts/presale-devbuy-plan.js`):
 *   - contributors sent `totalContributedLamports` SOL to the presale wallet
 *   - `reserveLamports` is held back (smart-contract deploy / ops)
 *   - the rest (`totalContributedLamports - reserveLamports`) is swept to the
 *     dev wallet, which adds `devExtraLamports` of its own and buys `T` tokens
 *     in a single dev-buy on the launchpad
 *   - presale pool tokens = T * (contributed - reserve) / (contributed - reserve + devExtra)
 *   - dev retained = T - presale pool tokens
 *   - presale pool is then split pro-rata across contributors by their
 *     `totalLamports` share of `contributed`
 *
 * Pure function — safe to dry-run without RPC access.
 *
 * @param {object} opts
 * @param {Array<{wallet:string,totalLamports:string}>} opts.contributors
 * @param {bigint} opts.totalContributedLamports
 * @param {bigint} opts.devBuyTokensRaw  Raw (mint-decimals) units from the dev-buy, or 0n for a
 *                                       preview that only needs percentages.
 * @param {bigint} opts.reserveLamports
 * @param {bigint} opts.devExtraLamports
 */
function computeDevBuyAllocations({
  contributors,
  totalContributedLamports,
  devBuyTokensRaw,
  reserveLamports,
  devExtraLamports,
}) {
  const total = BigInt(totalContributedLamports);
  const reserve = BigInt(reserveLamports);
  const devExtra = BigInt(devExtraLamports);
  if (reserve > total) {
    throw new Error(
      `reserveLamports (${reserve}) exceeds totalContributedLamports (${total})`,
    );
  }
  const fromPresale = total - reserve;
  const devBuySol = fromPresale + devExtra;
  if (devBuySol === 0n) {
    throw new Error('Dev buy size is zero — check reserve + devExtra vs total');
  }

  const T = BigInt(devBuyTokensRaw || 0);

  const presalePoolTokens = T === 0n ? 0n : (T * fromPresale) / devBuySol;
  const devRetainedTokens = T - presalePoolTokens;

  const allocations = allocateAllocations(contributors, presalePoolTokens);

  return {
    totalContributedLamports: total.toString(),
    reserveLamports: reserve.toString(),
    devExtraLamports: devExtra.toString(),
    fromPresaleLamports: fromPresale.toString(),
    devBuySolLamports: devBuySol.toString(),
    presalePoolShareBps: Number((fromPresale * 10_000n) / devBuySol),
    devRetainedShareBps: Number((devExtra * 10_000n) / devBuySol),
    devBuyTokensRaw: T.toString(),
    presalePoolTokens: presalePoolTokens.toString(),
    devRetainedTokens: devRetainedTokens.toString(),
    allocations: allocations.map((a) => ({
      wallet: a.wallet,
      lamports: a.lamports.toString(),
      shareBps: a.shareBps,
      tokens: a.tokens.toString(),
    })),
  };
}

function formatSol(lamports) {
  return (Number(BigInt(lamports)) / 1e9).toFixed(4);
}

function formatTokens(raw, decimals) {
  const div = 10n ** BigInt(decimals);
  const whole = raw / div;
  const frac = raw % div;
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return fracStr ? `${whole.toString()}.${fracStr}` : whole.toString();
}

module.exports = {
  getPresaleStateDir,
  contributionsPath,
  distributedPath,
  resolvePresaleConfig,
  loadContributions,
  saveContributions,
  loadDistributed,
  saveDistributed,
  extractInboundTransfers,
  aggregateContributions,
  allocateAllocations,
  computeDevBuyAllocations,
  formatSol,
  formatTokens,
};
