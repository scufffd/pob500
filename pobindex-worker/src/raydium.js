'use strict';

/**
 * raydium.js — SOL → SPL token swaps via Raydium's Trade API.
 *
 * Used as the primary swap engine for reward distribution.
 * Raydium's API is reachable from this environment; Jupiter's domains are not.
 *
 * Flow:
 *   1. GET /compute/swap-base-in  → quote (routePlan, outputAmount, etc.)
 *   2. GET /main/auto-fee         → priority fee recommendation
 *   3. POST /transaction/swap-base-in → serialised VersionedTransaction(s)
 *   4. Sign each tx with devKeypair and send via RPC
 */

const { VersionedTransaction } = require('@solana/web3.js');
const config  = require('./config');
const { logEvent } = require('./utils');

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const SOL_MINT = 'So11111111111111111111111111111111111111112';

const COMPUTE_HOST = 'https://transaction-v1.raydium.io';
const FEE_HOST     = 'https://api-v3.raydium.io';

// ── Helpers ───────────────────────────────────────────────────────────────────

// AbortSignal.timeout() requires Node 17.3+; use AbortController for compatibility.
function _makeSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Prevent the timer from keeping the process alive
  if (timer.unref) timer.unref();
  return controller.signal;
}

// Returns the parsed body; throws on HTTP errors or API-level failures.
async function _getBody(url, timeoutMs = 20_000) {
  const res = await fetch(url, { signal: _makeSignal(timeoutMs) });
  if (!res.ok) throw new Error(`Raydium HTTP ${res.status}: ${url}`);
  const body = await res.json();
  if (!body.success) throw new Error(`Raydium error: ${body.msg || JSON.stringify(body)}`);
  return body; // return FULL body — some callers need the wrapper fields
}

async function _post(url, payload, timeoutMs = 30_000) {
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    signal:  _makeSignal(timeoutMs),
    body:    JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Raydium HTTP ${res.status}: ${url}`);
  const body = await res.json();
  if (!body.success) throw new Error(`Raydium error: ${body.msg || JSON.stringify(body)}`);
  return body.data; // POST responses (transactions) use .data directly
}

async function _getPriorityFee() {
  try {
    const body = await _getBody(`${FEE_HOST}/main/auto-fee`, 8_000);
    return String(body?.data?.default?.h ?? 10_000);
  } catch {
    return '10000'; // fallback: 0.00001 SOL
  }
}

async function getTokenDecimals(mintAddress) {
  try {
    const { PublicKey } = require('@solana/web3.js');
    const info = await config.connection.getParsedAccountInfo(new PublicKey(mintAddress));
    return info?.value?.data?.parsed?.info?.decimals ?? 6;
  } catch {
    return 6;
  }
}

// ── Main swap function ────────────────────────────────────────────────────────

/**
 * Execute a SOL → token swap via Raydium.
 *
 * Mirrors the same interface as jupiter.swapSolToToken so the caller
 * doesn't need to change.
 *
 * @param {object} params
 * @param {import('@solana/web3.js').Keypair} params.devKeypair
 * @param {string}  params.outputMint
 * @param {number}  params.amountLamports
 * @param {number}  [params.slippageBps=500]
 * @returns {Promise<{ outAmount: bigint, decimals: number, txid: string }>}
 */
async function swapSolToToken({ devKeypair, outputMint, amountLamports, slippageBps = 500 }) {
  const swapId = Math.random().toString(36).slice(2, 8);
  logEvent('info', `[Raydium ${swapId}] SOL → ${outputMint} | ${(amountLamports / 1e9).toFixed(6)} SOL`);

  // ── Step 1: Quote ─────────────────────────────────────────────────────────
  // Raydium's transaction/swap-base-in endpoint requires the FULL compute
  // response (id, success, version, data fields) as its `swapResponse` field.
  const quoteUrl = `${COMPUTE_HOST}/compute/swap-base-in` +
    `?inputMint=${SOL_MINT}` +
    `&outputMint=${outputMint}` +
    `&amount=${amountLamports}` +
    `&slippageBps=${slippageBps}` +
    `&txVersion=V0`;

  const fullQuoteBody  = await _getBody(quoteUrl);   // full { id, success, version, data }
  const quoteData      = fullQuoteBody.data;          // inner data for reading output amount
  const outAmount      = BigInt(quoteData.outputAmount);

  logEvent('info', `[Raydium ${swapId}] Quote: ${outAmount} raw tokens out (${quoteData.priceImpactPct}% price impact)`);

  if (outAmount === 0n) {
    throw new Error(`Raydium returned 0 output for ${outputMint} — no liquidity`);
  }

  // ── Step 2: Priority fee ──────────────────────────────────────────────────
  const computeUnitPriceMicroLamports = await _getPriorityFee();

  // ── Step 3: Build transaction(s) ─────────────────────────────────────────
  const txList = await _post(`${COMPUTE_HOST}/transaction/swap-base-in`, {
    swapResponse:                   fullQuoteBody,    // FULL response required by Raydium
    wallet:                         devKeypair.publicKey.toBase58(),
    txVersion:                      'V0',
    wrapSol:                        true,
    unwrapSol:                      true,
    computeUnitPriceMicroLamports,
    inputAccount:                   undefined,
    outputAccount:                  undefined,
  });

  if (!Array.isArray(txList) || txList.length === 0) {
    throw new Error('Raydium returned no transactions');
  }

  logEvent('info', `[Raydium ${swapId}] Sending ${txList.length} transaction(s)`);

  // ── Step 4: Sign and confirm each tx ─────────────────────────────────────
  let lastTxid = '';

  for (let i = 0; i < txList.length; i++) {
    const { transaction: txBase64 } = txList[i];
    const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64'));

    // Raydium pre-serialises the blockhash — just sign and send
    tx.sign([devKeypair]);

    const txid = await config.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight:       false,
      preflightCommitment: 'confirmed',
      maxRetries:          3,
    });

    logEvent('info', `[Raydium ${swapId}] Tx ${i + 1}/${txList.length} sent`, { txid });

    const { blockhash, lastValidBlockHeight } = await config.connection.getLatestBlockhash('finalized');
    const { value: { err } } = await config.connection.confirmTransaction(
      { signature: txid, blockhash, lastValidBlockHeight },
      'confirmed',
    );
    if (err) throw new Error(`Raydium tx ${i + 1} failed on-chain: ${JSON.stringify(err)}`);

    logEvent('info', `[Raydium ${swapId}] Tx ${i + 1}/${txList.length} confirmed`, { txid });
    lastTxid = txid;
  }

  const decimals = await getTokenDecimals(outputMint);

  logEvent('info', `[Raydium ${swapId}] Swap complete`, {
    outAmount: outAmount.toString(),
    decimals,
    txid: lastTxid,
  });

  return { outAmount, decimals, txid: lastTxid };
}

module.exports = { swapSolToToken, getTokenDecimals, SOL_MINT };
