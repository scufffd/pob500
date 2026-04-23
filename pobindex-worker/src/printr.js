'use strict';

/**
 * Printr Partner API (OpenAPI in repo `printr-api.json`).
 * Discovery: GET /tokens/{id} and GET /tokens/{id}/deployments — there is no list endpoint;
 * supply mints / telecoin IDs via allowlist or PRINTR_DISCOVERY_IDS.
 *
 * Env:
 *   PRINTR_API_BASE        — overrides OpenAPI servers[0].url (default from printr-api.json)
 *   PRINTR_BEARER_TOKEN    — JWT (preferred) or use PRINTR_API_KEY
 *   PRINTR_OPENAPI_PATH    — optional path to OpenAPI JSON (default: pobindex-worker/printr-api.json)
 *   PRINTR_ALLOWLIST_PATH  — JSON { "candidates": [ { mint } | { telecoinId } | { apiId } ] }
 *   PRINTR_DISCOVERY_IDS   — comma-separated telecoin IDs or CAIP-10 Solana mints (alternative to allowlist)
 *
 * Auto dashboard pool (DexScreener → Printr validate):
 *   PRINTR_AUTO_DISCOVER     — unset / merge / 1 / on = merge Dex search mints when bearer is set (default).
 *                              0 | off = never. when-empty = only if allowlist+ids are empty.
 *   PRINTR_DEX_SEARCH_QUERIES — comma search terms for api.dexscreener.com/latest/dex/search (default: printr)
 *   PRINTR_DEX_SCREENER_DEX_ID — optional filter to a single dexId (e.g. meteoradbc)
 *   PRINTR_DEX_DISCOVER_CAP, PRINTR_DEX_PER_QUERY_CAP — limits (see dex-discovery.js)
 *
 * Optional extra keys in printr-api.json (same file as OpenAPI):
 *   "pobWorker": { "bearerToken": "..." }   — only used if env tokens unset (local dev convenience)
 *
 * Normalized candidate (Solana mint for swaps):
 *   { mint, symbol, name, chain: 'solana', printrTelecoinId?, imageUrl?, description?, ... }
 */

const fs = require('fs');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const { logEvent, withTimeout, sleep } = require('./utils');
const { fetchDexScreenerSolanaMintSeeds } = require('./dex-discovery');
const { fetchPrintrOnchainMintSeeds } = require('./onchain-discovery');

/** Solana mainnet CAIP-2 from Printr OpenAPI examples */
const SOLANA_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

const WORKER_ROOT = path.join(__dirname, '..');
const DEFAULT_OPENAPI_PATH = path.join(WORKER_ROOT, 'printr-api.json');

/**
 * @typedef {object} PrintrCandidate
 * @property {string} mint
 * @property {string} symbol
 * @property {string} name
 * @property {'solana'} chain
 * @property {number} [mcapUsd]
 * @property {number} [volume24hUsd]
 * @property {number} [liquidityUsd]
 * @property {number} [priceChange24h]
 * @property {number|null} [stakedPct] — after scoring: % in Printr-custody SPL (top-20)
 * @property {string} [source]
 * @property {string} [printrTelecoinId]
 * @property {string} [imageUrl]
 * @property {string} [description]
 */

function _asString(v) {
  if (v == null) return '';
  return String(v).trim();
}

function _asNumber(v) {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function looksLikeSolanaMintBase58(s) {
  if (!s || typeof s !== 'string' || s.includes(':')) return false;
  return /^[1-9A-HJ-NP-Za-km-z]{32,48}$/.test(s);
}

function solanaMintToCaip10(mint) {
  return `${SOLANA_CAIP2}:${mint.trim()}`;
}

function parseSolanaMintFromCaip10(id) {
  if (!id || typeof id !== 'string') return null;
  const prefix = `${SOLANA_CAIP2}:`;
  if (!id.startsWith(prefix)) return null;
  const rest = id.slice(prefix.length);
  return looksLikeSolanaMintBase58(rest) ? rest : null;
}

function loadOpenapiSpecFile() {
  const custom = process.env.PRINTR_OPENAPI_PATH;
  const candidate = custom
    ? (path.isAbsolute(custom) ? custom : path.join(process.cwd(), custom))
    : DEFAULT_OPENAPI_PATH;
  if (!fs.existsSync(candidate)) return { baseUrl: null, fileBearer: null };
  try {
    const j = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    const baseUrl = j.servers?.[0]?.url ? String(j.servers[0].url).replace(/\/$/, '') : null;
    const fileBearer = j.pobWorker?.bearerToken || j.pobWorker?.token || null;
    return { baseUrl, fileBearer: fileBearer ? String(fileBearer) : null };
  } catch (e) {
    logEvent('warn', 'Failed to read Printr OpenAPI JSON', { path: candidate, error: e.message });
    return { baseUrl: null, fileBearer: null };
  }
}

function resolvePrintrHttp() {
  const spec = loadOpenapiSpecFile();
  const baseUrl = _asString(process.env.PRINTR_API_BASE || spec.baseUrl || '').replace(/\/$/, '');
  const bearer =
    _asString(process.env.PRINTR_BEARER_TOKEN) ||
    _asString(process.env.PRINTR_API_KEY) ||
    _asString(spec.fileBearer);
  return { baseUrl, bearer, hasAuth: !!bearer };
}

async function printrFetchJson(baseUrl, bearer, pathname, label) {
  const url = `${baseUrl}${pathname.startsWith('/') ? '' : '/'}${pathname}`;
  const headers = { Accept: 'application/json' };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const res = await withTimeout(fetch(url, { headers }), 25_000, label);
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { _raw: text };
  }
  if (!res.ok) {
    const msg = body?.error?.message || text?.slice(0, 200) || res.statusText;
    throw new Error(`Printr ${label} HTTP ${res.status}: ${msg}`);
  }
  return body;
}

function pickTokenField(obj, camel, snake) {
  if (obj == null) return undefined;
  if (obj[camel] !== undefined && obj[camel] !== null) return obj[camel];
  if (obj[snake] !== undefined && obj[snake] !== null) return obj[snake];
  return undefined;
}

/**
 * Resolve Solana SPL mint from Printr token + deployments payloads.
 */
function resolveSolanaMint(apiId, tokenJson, deploymentsJson) {
  const fromCaip = parseSolanaMintFromCaip10(apiId);
  if (fromCaip) return fromCaip;

  const deps = deploymentsJson?.deployments || deploymentsJson?.Deployments || [];
  for (const d of deps) {
    const chain = d.chain_id || d.chainId;
    const status = (d.status || '').toLowerCase();
    const addr = d.contract_address || d.contractAddress;
    if (chain === SOLANA_CAIP2 && status === 'live' && addr && looksLikeSolanaMintBase58(addr)) return addr;
  }
  for (const d of deps) {
    const chain = d.chain_id || d.chainId;
    const addr = d.contract_address || d.contractAddress;
    if (chain === SOLANA_CAIP2 && addr && looksLikeSolanaMintBase58(addr)) return addr;
  }

  return null;
}

/**
 * @param {string} apiId — telecoin hex, or CAIP-10 `solana:...:MINT`
 * @returns {Promise<PrintrCandidate|null>}
 */
async function fetchPrintrTokenAsCandidate(baseUrl, bearer, apiId) {
  const enc = encodeURIComponent(apiId);
  const tokenJson = await printrFetchJson(baseUrl, bearer, `/tokens/${enc}`, 'getToken');
  let deploymentsJson = {};
  try {
    deploymentsJson = await printrFetchJson(baseUrl, bearer, `/tokens/${enc}/deployments`, 'getDeployments');
  } catch (e) {
    logEvent('warn', 'Printr deployments fetch failed — mint may be incomplete', {
      apiId: apiId.slice(0, 24),
      error: e.message,
    });
  }

  const mint = resolveSolanaMint(apiId, tokenJson, deploymentsJson);
  if (!mint) {
    logEvent('warn', 'Could not resolve Solana mint for Printr token', { apiId: apiId.slice(0, 40) });
    return null;
  }

  const name = _asString(pickTokenField(tokenJson, 'name', 'name')) || 'Unknown';
  const symbol = _asString(pickTokenField(tokenJson, 'symbol', 'symbol')) || mint.slice(0, 4);
  const description = _asString(pickTokenField(tokenJson, 'description', 'description')) || '';
  const imageUrl = _asString(pickTokenField(tokenJson, 'imageUrl', 'image_url')) || '';
  const printrTelecoinId = _asString(pickTokenField(tokenJson, 'id', 'id')) || '';

  return {
    mint,
    symbol,
    name,
    description,
    imageUrl,
    printrTelecoinId,
    chain: 'solana',
    source: 'printr',
  };
}

function loadDiscoverySeeds() {
  const idsEnv = _asString(process.env.PRINTR_DISCOVERY_IDS);
  if (idsEnv) {
    return idsEnv
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(raw => {
        if (looksLikeSolanaMintBase58(raw)) {
          return { apiId: solanaMintToCaip10(raw), mintHint: raw, source: 'ids-env' };
        }
        return { apiId: raw, mintHint: parseSolanaMintFromCaip10(raw), source: 'ids-env' };
      });
  }

  const allowPath = process.env.PRINTR_ALLOWLIST_PATH;
  if (!allowPath) return [];

  const abs = path.isAbsolute(allowPath) ? allowPath : path.join(process.cwd(), allowPath);
  const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const arr = raw.candidates || raw.tokens || raw;
  if (!Array.isArray(arr)) throw new Error('Allowlist JSON must contain a candidates array');
  const seeds = [];
  for (const row of arr) {
    if (!row || typeof row !== 'object') continue;
    const telecoinId = _asString(row.telecoinId || row.token_id || row.tokenId);
    const mint = _asString(row.mint || row.address);
    const apiId = _asString(row.apiId || row.id);
    if (telecoinId) {
      seeds.push({ apiId: telecoinId, mintHint: mint || null, source: 'allowlist' });
    } else if (mint && looksLikeSolanaMintBase58(mint)) {
      seeds.push({ apiId: solanaMintToCaip10(mint), mintHint: mint, source: 'allowlist' });
    } else if (apiId) {
      seeds.push({ apiId, mintHint: mint || parseSolanaMintFromCaip10(apiId), source: 'allowlist' });
    }
  }
  return seeds;
}

function seedKey(s) {
  return String(s.apiId || s.mintHint || '');
}

function mergeDexSeedsInto(seeds, dexRows) {
  const seen = new Set(seeds.map(seedKey).filter(Boolean));
  for (const d of dexRows) {
    const apiId = solanaMintToCaip10(d.mint);
    if (seen.has(apiId)) continue;
    seen.add(apiId);
    seeds.push({
      apiId,
      mintHint: d.mint,
      source: 'dex',
      dexMeta: d,
    });
  }
}

function mergeOnchainMintsInto(seeds, mints) {
  const seen = new Set(seeds.map(seedKey).filter(Boolean));
  let added = 0;
  for (const m of mints) {
    if (!looksLikeSolanaMintBase58(m)) continue;
    const apiId = solanaMintToCaip10(m);
    if (seen.has(apiId)) continue;
    seen.add(apiId);
    seeds.push({ apiId, mintHint: m, source: 'onchain' });
    added++;
  }
  return added;
}

function shouldUseOnchainDiscovery() {
  const v = (process.env.PRINTR_ONCHAIN_DISCOVER || '').toLowerCase().trim();
  if (v === '0' || v === 'off' || v === 'false' || v === 'no') return false;
  return true; // default on
}

/** Whether to pull Solana mints from DexScreener and validate on Printr. */
function shouldMergeDexScreenerDiscovery(initialSeedCount, hasAuth, baseUrl) {
  if (!hasAuth || !baseUrl) return false;
  const v = (process.env.PRINTR_AUTO_DISCOVER || '').toLowerCase().trim();
  if (v === '0' || v === 'off' || v === 'false') return false;
  if (v === 'when-empty' || v === 'if-empty') return initialSeedCount === 0;
  return true;
}

/**
 * Map arbitrary API / allowlist record to PrintrCandidate (DexScreener fills mcap later).
 */
function normalizeRecord(raw, source = 'allowlist') {
  const mint =
    _asString(raw.mint || raw.address || raw.contractAddress || raw.tokenAddress || raw.ca);
  if (!mint) return null;

  const chainRaw = (_asString(raw.chain || raw.chainId || raw.network) || 'solana').toLowerCase();
  if (chainRaw !== 'solana' && chainRaw !== 'sol') return null;

  return {
    mint,
    symbol: _asString(raw.symbol || raw.ticker || raw.sym) || mint.slice(0, 4),
    name: _asString(raw.name || raw.title || raw.symbol) || 'Unknown',
    description: _asString(raw.description) || undefined,
    imageUrl: _asString(raw.imageUrl || raw.image_url) || undefined,
    printrTelecoinId: _asString(raw.printrTelecoinId) || undefined,
    chain: 'solana',
    mcapUsd: _asNumber(raw.mcapUsd ?? raw.marketCapUsd ?? raw.fdv ?? raw.marketCap),
    volume24hUsd: _asNumber(raw.volume24hUsd ?? raw.volume24h ?? raw.volumeUsd),
    liquidityUsd: _asNumber(raw.liquidityUsd ?? raw.liquidity),
    priceChange24h: _asNumber(raw.priceChange24h ?? raw.priceChangeH24 ?? raw.change24h),
    source,
  };
}

/**
 * @returns {Promise<PrintrCandidate[]>}
 */
async function fetchPrintrSolanaCandidates() {
  const { baseUrl, bearer, hasAuth } = resolvePrintrHttp();
  const seeds = loadDiscoverySeeds();
  const initialSeedCount = seeds.length;

  if (shouldMergeDexScreenerDiscovery(initialSeedCount, hasAuth, baseUrl)) {
    try {
      const dexRows = await fetchDexScreenerSolanaMintSeeds();
      mergeDexSeedsInto(seeds, dexRows);
      logEvent('info', 'Discovery seeds after DexScreener merge', {
        total: seeds.length,
        fromAllowlistOrIds: initialSeedCount,
        addedFromDex: seeds.length - initialSeedCount,
      });
    } catch (e) {
      logEvent('warn', 'DexScreener auto-discover failed', { error: e.message });
    }
  }

  // On-chain discovery via Helius enhanced transactions on the Printr program.
  // These mints are almost all Printr tokens, but we still let the Printr API
  // validator drop any false positives (e.g. LP tokens, fee-vault mints).
  if (hasAuth && shouldUseOnchainDiscovery()) {
    try {
      const priorCount = seeds.length;
      const { mints, newestSignature, pagesFetched, txCount } = await fetchPrintrOnchainMintSeeds();
      const added = mergeOnchainMintsInto(seeds, mints);
      logEvent('info', 'Discovery seeds after on-chain merge', {
        total: seeds.length,
        addedFromOnchain: added,
        priorCount,
        onchainMints: mints.length,
        pagesFetched,
        txCount,
        newestSignature: newestSignature ? `${newestSignature.slice(0, 12)}…` : null,
      });
    } catch (e) {
      logEvent('warn', 'On-chain auto-discover failed', { error: e.message });
    }
  }

  if (seeds.length === 0) {
    throw new Error(
      'No discovery seeds: add allowlist mints / telecoinIds, set PRINTR_DISCOVERY_IDS, ' +
        'or enable Printr bearer + Dex merge (PRINTR_AUTO_DISCOVER unset or merge) so DexScreener can seed the pool.'
    );
  }

  if (!baseUrl || !hasAuth) {
    throw new Error(
      'Printr API base + bearer token are required to list only Printr-created tokens. ' +
        'Set PRINTR_API_BASE and PRINTR_BEARER_TOKEN (or PRINTR_API_KEY) in the worker .env.'
    );
  }

  logEvent('info', 'Printr discovery via token details API', {
    baseUrl,
    seedCount: seeds.length,
  });

  // Validate every seed against Printr /tokens/{id}. Non-Printr tokens are
  // dropped — there is intentionally NO fallback to raw / allowlist records
  // so DexScreener noise (e.g. JUP) cannot appear on the dashboard.
  const out = [];
  let rejected = 0;
  for (const seed of seeds) {
    try {
      const c = await fetchPrintrTokenAsCandidate(baseUrl, bearer, seed.apiId);
      if (c) {
        if (seed.dexMeta && typeof seed.dexMeta.volumeH24 === 'number') {
          c.dexPreviewVolumeUsd = seed.dexMeta.volumeH24;
        }
        out.push(c);
      } else {
        rejected++;
      }
    } catch (e) {
      rejected++;
      // 404 / 500 "token not found" is the common case for non-Printr mints;
      // log at debug-ish verbosity so it doesn't spam the console.
      const msg = e.message || '';
      if (!/token not found/i.test(msg)) {
        logEvent('warn', 'Printr token validation failed', {
          apiId: seed.apiId?.slice(0, 40),
          error: msg,
        });
      }
    }
    await sleep(150);
  }

  const seen = new Set();
  const deduped = out.filter(c => {
    if (seen.has(c.mint)) return false;
    seen.add(c.mint);
    return true;
  });
  logEvent('info', 'Printr candidates resolved', {
    count: deduped.length,
    rejected,
    totalProbed: seeds.length,
  });
  return deduped;
}

module.exports = {
  fetchPrintrSolanaCandidates,
  normalizeRecord,
  solanaMintToCaip10,
  parseSolanaMintFromCaip10,
  SOLANA_CAIP2,
  resolvePrintrHttp,
};
