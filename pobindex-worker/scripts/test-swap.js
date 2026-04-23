#!/usr/bin/env node
'use strict';

/**
 * test-swap.js — tiny mainnet SOL → Printr token swap to prove the full
 * creator-fee swap path works end-to-end (Raydium first, Jupiter fallback).
 *
 * Usage:
 *   node scripts/test-swap.js                              # defaults below
 *   node scripts/test-swap.js --mint <MINT> --sol 0.002    # custom
 *   node scripts/test-swap.js --payer creator              # use CREATOR_WALLET_PRIVATE_KEY
 *
 * Defaults:
 *   mint  = GfnKmzMRiB2yVrZrri7natbaDBMf4747VUhzCuAwbrrr  (the test Printr coin)
 *   sol   = 0.002  (≈ $0.4 @ $200)
 *   payer = creator (falls back to treasury if creator key not set)
 *
 * The script is read-mostly safe: if balance is insufficient it exits without
 * sending a tx. On success it prints the signature and the observed balance
 * delta for the ATA (accounting for Token-2022 vs legacy mints).
 */

const {
  PublicKey,
  Connection,
} = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} = require('@solana/spl-token');

const config = require('../src/config');
const { swapSolToToken } = require('../src/distribute');

const DEFAULT_MINT = 'GfnKmzMRiB2yVrZrri7natbaDBMf4747VUhzCuAwbrrr';
const DEFAULT_SOL = 0.002;

function parseArgs(argv) {
  const out = { mint: DEFAULT_MINT, sol: DEFAULT_SOL, payer: null, slippageBps: 500 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[i + 1];
    if (a === '--mint') { out.mint = next(); i += 1; }
    else if (a === '--sol') { out.sol = parseFloat(next()); i += 1; }
    else if (a === '--payer') { out.payer = next(); i += 1; }
    else if (a === '--slippage') { out.slippageBps = parseInt(next(), 10); i += 1; }
  }
  return out;
}

function pickPayerKey(label) {
  const treasuryRaw = process.env.TREASURY_PRIVATE_KEY;
  const creatorRaw = process.env.CREATOR_WALLET_PRIVATE_KEY;
  if (label === 'treasury') {
    if (!treasuryRaw) throw new Error('TREASURY_PRIVATE_KEY not set');
    return { label: 'treasury', raw: treasuryRaw };
  }
  if (label === 'creator') {
    if (!creatorRaw) throw new Error('CREATOR_WALLET_PRIVATE_KEY not set');
    return { label: 'creator', raw: creatorRaw };
  }
  // auto: prefer creator (claimed fees live there), fall back to treasury
  if (creatorRaw) return { label: 'creator', raw: creatorRaw };
  if (treasuryRaw) return { label: 'treasury', raw: treasuryRaw };
  throw new Error('Neither CREATOR_WALLET_PRIVATE_KEY nor TREASURY_PRIVATE_KEY set');
}

async function detectTokenProgram(connection, mint) {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`Mint ${mint.toBase58()} not found on cluster ${config.RPC_URL}`);
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return { programId: TOKEN_2022_PROGRAM_ID, label: 'Token-2022' };
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return { programId: TOKEN_PROGRAM_ID, label: 'Legacy SPL' };
  throw new Error(`Mint owner is not a token program: ${info.owner.toBase58()}`);
}

async function readBalance(connection, ata) {
  try {
    const info = await connection.getTokenAccountBalance(ata);
    return BigInt(info.value.amount);
  } catch {
    return 0n;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const payerSpec = pickPayerKey(args.payer);
  const payer = config.parsePrivateKey(payerSpec.raw);
  const mint = new PublicKey(args.mint);
  const lamports = Math.round(args.sol * 1e9);

  console.log('— POB test-swap —');
  console.log('cluster     :', config.RPC_URL);
  console.log('payer       :', payerSpec.label, payer.publicKey.toBase58());
  console.log('output mint :', mint.toBase58());
  console.log('amount      :', args.sol, 'SOL', `(${lamports} lamports)`);
  console.log('slippage    :', args.slippageBps, 'bps');

  const conn = config.connection;

  const balance = await conn.getBalance(payer.publicKey);
  console.log('payer SOL   :', balance / 1e9);
  const feeBuffer = 10_000_000; // ~0.01 SOL for rent + fees
  if (balance < lamports + feeBuffer) {
    console.error(
      `Insufficient balance: need ${(lamports + feeBuffer) / 1e9} SOL, have ${balance / 1e9}`,
    );
    process.exit(3);
  }

  const { programId, label: progLabel } = await detectTokenProgram(conn, mint);
  console.log('mint prog   :', progLabel, programId.toBase58());

  const ata = getAssociatedTokenAddressSync(mint, payer.publicKey, false, programId);
  console.log('payer ATA   :', ata.toBase58());

  const beforeRaw = await readBalance(conn, ata);
  console.log('before raw  :', beforeRaw.toString());

  const t0 = Date.now();
  const result = await swapSolToToken({
    devKeypair: payer,
    outputMint: mint.toBase58(),
    amountLamports: lamports,
    slippageBps: args.slippageBps,
  });
  const dt = Date.now() - t0;

  const afterRaw = await readBalance(conn, ata);
  const delta = afterRaw - beforeRaw;

  console.log('');
  console.log('— swap done —');
  console.log('elapsed     :', dt, 'ms');
  const safeResult = {
    ...result,
    outAmount: result && result.outAmount != null ? result.outAmount.toString() : null,
  };
  console.log('result      :', JSON.stringify(safeResult, null, 2));
  console.log('after raw   :', afterRaw.toString());
  console.log('delta raw   :', delta.toString());
  if (delta <= 0n) {
    console.error('FAIL: balance did not increase');
    process.exit(4);
  }
  console.log('PASS');
}

main().catch((e) => {
  console.error('FAIL', e.message || e);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
