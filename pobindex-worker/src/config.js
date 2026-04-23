'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const { Connection, Keypair } = require('@solana/web3.js');

function requireEnv(key) {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required environment variable: ${key}`);
  return v;
}

function parsePrivateKey(raw) {
  if (!raw) throw new Error('Private key is empty');
  try {
    const parsed = JSON.parse(raw);
    return Keypair.fromSecretKey(Uint8Array.from(parsed));
  } catch (_) {
    const bs58 = require('bs58');
    return Keypair.fromSecretKey(Uint8Array.from(bs58.decode(String(raw))));
  }
}

const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC_URL, 'confirmed');

// Separate RPC for the staking program (deployed on devnet during testing).
// Falls back to RPC_URL when unset so prod / single-cluster setups keep working.
const STAKE_RPC_URL = process.env.STAKE_RPC_URL || RPC_URL;
const stakeConnection = STAKE_RPC_URL === RPC_URL
  ? connection
  : new Connection(STAKE_RPC_URL, 'confirmed');

// Presale SOL indexing (getSignaturesForAddress on the presale wallet). Defaults
// to mainnet `RPC_URL`. Set to devnet Helius when running a devnet drill so
// scans hit the same cluster as `STAKE_RPC_URL`.
const PRESALE_RPC_URL = process.env.POBINDEX_PRESALE_RPC_URL || RPC_URL;
const presaleConnection = PRESALE_RPC_URL === RPC_URL
  ? connection
  : new Connection(PRESALE_RPC_URL, 'confirmed');

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || '';

const SOLANA_MIN_RENT_EXEMPT_LAMPORTS = 890880;
const MIN_HOLDER_BALANCE = BigInt(process.env.MIN_HOLDER_BALANCE || '1');

const SOL_RESERVE_LAMPORTS = Math.round(parseFloat(process.env.SOL_RESERVE || '0.02') * 1e9);
const DIST_PCT = Math.min(100, Math.max(1, parseFloat(process.env.DIST_PCT || '25')));

const PRIORITY_FEE = parseFloat(process.env.PRIORITY_FEE || '0.000001');
const ONE_TIME_PRIORITY_FEE = process.env.ONE_TIME_PRIORITY_FEE !== undefined && process.env.ONE_TIME_PRIORITY_FEE !== ''
  ? parseFloat(process.env.ONE_TIME_PRIORITY_FEE)
  : PRIORITY_FEE;
const NETWORK_TIMEOUT_MS = 30_000;
const CONFIRM_TIMEOUT_MS = 60_000;

// Worker lives at POBINDEX/pobindex-worker/src — UI_ROOT is POBINDEX/.
const UI_ROOT = path.join(__dirname, '..', '..');
const DEFAULT_DATA_JSON = path.join(UI_ROOT, 'public', 'pobindex-data.json');
const POBINDEX_DATA_JSON = process.env.POBINDEX_DATA_JSON || DEFAULT_DATA_JSON;

const TENURE_DB_PATH = process.env.TENURE_DB_PATH || path.join(__dirname, '..', 'data', 'pobindex-tenure.sqlite');

module.exports = {
  RPC_URL,
  connection,
  STAKE_RPC_URL,
  stakeConnection,
  PRESALE_RPC_URL,
  presaleConnection,
  HELIUS_API_KEY,
  JUPITER_API_KEY,
  parsePrivateKey,
  requireEnv,
  MIN_HOLDER_BALANCE,
  SOL_RESERVE_LAMPORTS,
  DIST_PCT,
  PRIORITY_FEE,
  ONE_TIME_PRIORITY_FEE,
  NETWORK_TIMEOUT_MS,
  CONFIRM_TIMEOUT_MS,
  SOLANA_MIN_RENT_EXEMPT_LAMPORTS,
  POBINDEX_DATA_JSON,
  TENURE_DB_PATH,
};
