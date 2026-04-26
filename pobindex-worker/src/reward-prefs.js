'use strict';

/**
 * reward-prefs.js — per-wallet personalized reward token preferences.
 *
 * Storage model:
 *   { schemaVersion: 2, prefs: { <walletBase58>: PreferenceRecord } }
 *
 * PreferenceRecord:
 *   {
 *     mode: 'auto' | 'custom',
 *     allocations: [{ mint, symbol, name, decimals, pct }, ...],
 *     updatedAt: ISO8601,
 *     signature: base58,        // signed by wallet over `message`
 *     message: string,          // exact bytes the wallet signed
 *     validation: ValidationSnapshot[]   // last good validation per mint
 *   }
 *
 * Rules:
 *   - mode='auto'  → empty allocations, no validation (uses default basket)
 *   - mode='custom' → 1..3 allocations, integers summing to 100, every mint
 *     individually validated by token-validator before save
 *
 * Save flow:
 *   1. UI gathers desired allocations and a current `nonce` from the server.
 *   2. UI signs the canonical message string with the wallet.
 *   3. UI POSTs `{wallet, allocations, message, signature, nonce}`.
 *   4. Server verifies signature, re-validates each mint, persists.
 *
 * Auto-revert on validation failure during a spend cycle: callers can use
 * `markAllocationFailure(wallet, mint, reason)` which trips `mode` to 'auto'
 * and stores the reason. The frontend reads `lastFailure` to surface a
 * banner so the user knows their token was downgraded.
 */

const fs = require('fs');
const path = require('path');
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const { PublicKey } = require('@solana/web3.js');

const config = require('./config');
const { logEvent } = require('./utils');
const { validateRewardMint, SOL_MINT } = require('./token-validator');

const PREFS_FILE = process.env.REWARD_PREFS_FILE
  || path.join(__dirname, '..', 'data', 'reward-prefs.json');
const NONCE_TTL_MS = parseInt(process.env.REWARD_PREF_NONCE_TTL_MS || (5 * 60_000), 10);
const MAX_ALLOCATIONS = 3;
const MESSAGE_PREFIX = 'POB500_REWARD_PREF_V1';
const COMPOUND_LOCK_TIERS = [1, 3, 7, 14, 21, 30];

// In-memory nonce store. We persist nothing here — restarting the worker
// just means anyone in the middle of signing has to refresh, which is fine.
const nonces = new Map();

function emptyDoc() {
  return { schemaVersion: 2, prefs: {} };
}

function loadDoc() {
  try {
    const raw = fs.readFileSync(PREFS_FILE, 'utf8');
    const doc = JSON.parse(raw);
    if (!doc || typeof doc !== 'object') return emptyDoc();
    if (!doc.prefs || typeof doc.prefs !== 'object') doc.prefs = {};
    if (!doc.schemaVersion) doc.schemaVersion = 1;
    return doc;
  } catch (_) {
    return emptyDoc();
  }
}

function saveDoc(doc) {
  fs.mkdirSync(path.dirname(PREFS_FILE), { recursive: true });
  const tmp = `${PREFS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, PREFS_FILE);
}

function isValidPubkey(value) {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

function newNonce(wallet) {
  if (!wallet || !isValidPubkey(wallet)) {
    const e = new Error('invalid_wallet');
    e.code = 'invalid_wallet';
    throw e;
  }
  const nonce = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  nonces.set(`${wallet}|${nonce}`, Date.now());
  // Garbage-collect old nonces opportunistically.
  for (const [k, ts] of nonces) {
    if (Date.now() - ts > NONCE_TTL_MS) nonces.delete(k);
  }
  return nonce;
}

function consumeNonce(wallet, nonce) {
  const key = `${wallet}|${nonce}`;
  const ts = nonces.get(key);
  if (!ts) return false;
  nonces.delete(key);
  return Date.now() - ts <= NONCE_TTL_MS;
}

function normalizeCompound(input) {
  if (!input || typeof input !== 'object') {
    return { enabled: false, lockDays: 0 };
  }
  const enabled = input.enabled === true;
  if (!enabled) return { enabled: false, lockDays: 0 };
  const lockDays = Number(input.lockDays);
  if (!Number.isInteger(lockDays) || !COMPOUND_LOCK_TIERS.includes(lockDays)) {
    const e = new Error(`compound.lockDays must be one of: ${COMPOUND_LOCK_TIERS.join(', ')}`);
    e.code = 'compound_invalid_lock_days';
    throw e;
  }
  return { enabled: true, lockDays };
}

/**
 * Canonical message a wallet must sign to save preferences. Keep this
 * deterministic — any change here means we ship a v2 prefix and ignore old
 * signatures rather than silently invalidating saves.
 *
 * Compound is part of the signed payload: a malicious server can't unilaterally
 * stake user rewards without the wallet authorising the chosen lock tier.
 */
function buildSignableMessage({ wallet, mode, allocations, compound, nonce, issuedAt }) {
  const allocs = (allocations || [])
    .map((a) => `${a.mint}:${a.pct}`)
    .join(',');
  const c = compound && compound.enabled
    ? `enabled:${compound.lockDays}`
    : 'disabled';
  return [
    MESSAGE_PREFIX,
    `wallet:${wallet}`,
    `mode:${mode}`,
    `allocations:${allocs}`,
    `compound:${c}`,
    `nonce:${nonce}`,
    `issuedAt:${issuedAt}`,
  ].join('|');
}

function verifySignature({ wallet, message, signature }) {
  try {
    const pubkey = new PublicKey(wallet).toBytes();
    const sigBytes = bs58.decode(signature);
    const msgBytes = new TextEncoder().encode(message);
    return nacl.sign.detached.verify(msgBytes, sigBytes, pubkey);
  } catch (_) {
    return false;
  }
}

function normalizeAllocations(input) {
  if (!Array.isArray(input)) {
    const e = new Error('allocations_must_be_array');
    e.code = 'allocations_invalid';
    throw e;
  }
  if (input.length === 0) {
    const e = new Error('At least one allocation required for custom mode');
    e.code = 'allocations_empty';
    throw e;
  }
  if (input.length > MAX_ALLOCATIONS) {
    const e = new Error(`Maximum ${MAX_ALLOCATIONS} reward tokens`);
    e.code = 'allocations_too_many';
    throw e;
  }
  let total = 0;
  const seen = new Set();
  const cleaned = input.map((a) => {
    if (!a || typeof a !== 'object') {
      const e = new Error('allocation_must_be_object');
      e.code = 'allocations_invalid';
      throw e;
    }
    if (!isValidPubkey(a.mint)) {
      const e = new Error(`Invalid mint: ${a.mint}`);
      e.code = 'invalid_mint';
      throw e;
    }
    if (seen.has(a.mint)) {
      const e = new Error(`Duplicate mint in allocations: ${a.mint}`);
      e.code = 'duplicate_mint';
      throw e;
    }
    seen.add(a.mint);
    const pct = Number(a.pct);
    if (!Number.isInteger(pct) || pct < 1 || pct > 100) {
      const e = new Error('pct must be an integer between 1 and 100');
      e.code = 'allocations_invalid_pct';
      throw e;
    }
    total += pct;
    return { mint: a.mint, pct };
  });
  if (total !== 100) {
    const e = new Error(`Allocations must sum to 100 (got ${total})`);
    e.code = 'allocations_bad_total';
    throw e;
  }
  return cleaned;
}

function getPreference(wallet) {
  const doc = loadDoc();
  const record = doc.prefs[wallet];
  if (!record) {
    return {
      wallet,
      mode: 'auto',
      allocations: [],
      compound: { enabled: false, lockDays: 0 },
      updatedAt: null,
      lastFailure: null,
    };
  }
  // Backfill compound for older records that pre-date the field.
  if (!record.compound) record.compound = { enabled: false, lockDays: 0 };
  return record;
}

function listAllPreferences() {
  const doc = loadDoc();
  return doc.prefs;
}

async function savePreference({
  wallet,
  mode,
  allocations,
  compound,
  message,
  signature,
  nonce,
  issuedAt,
}) {
  if (!isValidPubkey(wallet)) {
    const e = new Error('invalid_wallet');
    e.code = 'invalid_wallet';
    throw e;
  }
  if (!['auto', 'custom'].includes(mode)) {
    const e = new Error('mode must be "auto" or "custom"');
    e.code = 'invalid_mode';
    throw e;
  }
  if (typeof message !== 'string' || typeof signature !== 'string' || typeof nonce !== 'string') {
    const e = new Error('message_signature_nonce_required');
    e.code = 'missing_fields';
    throw e;
  }
  const issuedAtMs = Number(issuedAt);
  if (!Number.isFinite(issuedAtMs) || Math.abs(Date.now() - issuedAtMs) > NONCE_TTL_MS) {
    const e = new Error('issuedAt_out_of_range');
    e.code = 'expired_request';
    throw e;
  }
  if (!consumeNonce(wallet, nonce)) {
    const e = new Error('Nonce expired or unknown — request a fresh nonce and retry');
    e.code = 'expired_nonce';
    throw e;
  }

  const cleanedAllocs = mode === 'custom' ? normalizeAllocations(allocations) : [];
  const cleanedCompound = normalizeCompound(compound);
  const stakeMintEnv = (process.env.POB_STAKE_MINT || '').trim();
  if (cleanedCompound.enabled) {
    if (mode !== 'custom') {
      const e = new Error('Compound requires custom mode');
      e.code = 'compound_requires_custom';
      throw e;
    }
    if (!stakeMintEnv) {
      const e = new Error('POB_STAKE_MINT not configured on server');
      e.code = 'stake_mint_unconfigured';
      throw e;
    }
    const hasStakeAlloc = cleanedAllocs.some((a) => a.mint === stakeMintEnv);
    if (!hasStakeAlloc) {
      const e = new Error('Compound requires the stake mint to be among your allocations');
      e.code = 'compound_requires_stake_alloc';
      throw e;
    }
  }

  const expectedMessage = buildSignableMessage({
    wallet,
    mode,
    allocations: cleanedAllocs,
    compound: cleanedCompound,
    nonce,
    issuedAt: issuedAtMs,
  });
  if (expectedMessage !== message) {
    const e = new Error('message_mismatch');
    e.code = 'message_mismatch';
    throw e;
  }
  if (!verifySignature({ wallet, message, signature })) {
    const e = new Error('signature_invalid');
    e.code = 'signature_invalid';
    throw e;
  }

  // Re-validate every mint server-side. Frontend can validate first to give
  // instant feedback, but we never trust client validation for a save.
  const validations = [];
  if (mode === 'custom') {
    for (const a of cleanedAllocs) {
      const snapshot = await validateRewardMint(a.mint);
      validations.push({ ...snapshot, pct: a.pct });
    }
  }

  const enrichedAllocs = mode === 'custom'
    ? validations.map((v) => ({
      mint: v.mint,
      symbol: v.symbol,
      name: v.name,
      decimals: v.decimals,
      pct: v.pct,
      tokenProgram: v.tokenProgram,
    }))
    : [];

  const record = {
    mode,
    allocations: enrichedAllocs,
    compound: cleanedCompound,
    updatedAt: new Date().toISOString(),
    issuedAt: issuedAtMs,
    signature,
    message,
    validation: validations.map((v) => ({
      mint: v.mint,
      liquidityUsd: v.liquidityUsd,
      volume24hUsd: v.volume24hUsd,
      rugcheckScore: v.rugcheckScore,
      warnings: v.warnings,
      validatedAt: new Date().toISOString(),
    })),
    lastFailure: null,
  };

  const doc = loadDoc();
  doc.prefs[wallet] = record;
  saveDoc(doc);

  logEvent('info', 'reward-pref saved', {
    wallet,
    mode,
    allocCount: enrichedAllocs.length,
  });
  return record;
}

function markAllocationFailure(wallet, mint, reason) {
  const doc = loadDoc();
  const rec = doc.prefs[wallet];
  if (!rec || rec.mode !== 'custom') return;
  rec.mode = 'auto';
  rec.allocations = [];
  rec.lastFailure = {
    revertedAt: new Date().toISOString(),
    mint,
    reason,
  };
  doc.prefs[wallet] = rec;
  saveDoc(doc);
  logEvent('warn', 'reward-pref auto-reverted to auto-basket', { wallet, mint, reason });
}

module.exports = {
  PREFS_FILE,
  MAX_ALLOCATIONS,
  MESSAGE_PREFIX,
  COMPOUND_LOCK_TIERS,
  newNonce,
  buildSignableMessage,
  getPreference,
  listAllPreferences,
  savePreference,
  markAllocationFailure,
  SOL_MINT,
};
