'use strict';

/**
 * Tiny in-memory TTL cache for `getAccountInfo` results.
 *
 * Mint accounts (owner = Token / Token-2022) never change program ownership;
 * caching them cuts repeated Helius credits across basket refresh, stake-push,
 * token-validator, and personalized paths.
 *
 * Env: POB_RPC_ACCOUNT_CACHE_TTL_MS (default 6h). Set to 0 to disable caching.
 */

const DEFAULT_TTL_MS = parseInt(process.env.POB_RPC_ACCOUNT_CACHE_TTL_MS || String(6 * 60 * 60 * 1000), 10);
const NULL_TTL_MS = Math.min(120_000, Math.max(10_000, DEFAULT_TTL_MS / 24)); // short negative cache

const store = new Map(); // key -> { expiry, data }

function keyOf(pubkey, commitment) {
  const pk = typeof pubkey.toBase58 === 'function' ? pubkey.toBase58() : String(pubkey);
  return `${pk}:${commitment || 'confirmed'}`;
}

/**
 * @param {import('@solana/web3.js').Connection} connection
 * @param {import('@solana/web3.js').PublicKey} pubkey
 * @param {{ commitment?: string, ttlMs?: number }} [opts]
 */
async function getAccountInfoCached(connection, pubkey, opts = {}) {
  const commitment = opts.commitment || connection.commitment || 'confirmed';
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  if (ttlMs <= 0) {
    return connection.getAccountInfo(pubkey, commitment);
  }
  const k = keyOf(pubkey, commitment);
  const now = Date.now();
  const hit = store.get(k);
  if (hit && hit.expiry > now) return hit.data;

  const data = await connection.getAccountInfo(pubkey, commitment);
  const nullTtl = data == null ? NULL_TTL_MS : ttlMs;
  store.set(k, { expiry: now + nullTtl, data });
  return data;
}

function clearRpcAccountCache() {
  store.clear();
}

/** Helius / public RPCs typically cap ~100 accounts per `getMultipleAccounts`. */
const MULTI_CHUNK = 99;

/**
 * @param {import('@solana/web3.js').Connection} connection
 * @param {import('@solana/web3.js').PublicKey[]} pubkeys
 * @param {import('@solana/web3.js').Commitment} [commitment]
 * @returns {Promise<(import('@solana/web3.js').AccountInfo<Buffer> | null)[]>}
 */
async function getMultipleAccountsInfoChunked(connection, pubkeys, commitment) {
  if (!pubkeys.length) return [];
  const comm = commitment || connection.commitment || 'confirmed';
  const out = [];
  for (let i = 0; i < pubkeys.length; i += MULTI_CHUNK) {
    const slice = pubkeys.slice(i, i + MULTI_CHUNK);
    const part = await connection.getMultipleAccountsInfo(slice, comm);
    out.push(...part);
  }
  return out;
}

module.exports = {
  getAccountInfoCached,
  clearRpcAccountCache,
  getMultipleAccountsInfoChunked,
};
