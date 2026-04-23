'use strict';

/**
 * jupiter.js — SOL → SPL token swaps via Jupiter Aggregator.
 *
 * Used by the rewards distribution phase to convert claimed SOL fees into
 * a holder's preferred reward token before sending it to them.
 *
 * Key difference from the USX implementation:
 *   - Takes devKeypair as a parameter (no singleton treasury wallet)
 *   - No Universal / uAsset routing
 *   - Simpler retry logic (no circuit breaker)
 */

const { VersionedTransaction, PublicKey } = require('@solana/web3.js');
const config = require('./config');
const { logEvent } = require('./utils');

const JUPITER_BASE = 'https://api.jup.ag/swap/v1';
const _jupHeaders  = () => {
  const h = { 'Content-Type': 'application/json' };
  if (config.JUPITER_API_KEY) h['x-api-key'] = config.JUPITER_API_KEY;
  return h;
};

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

function _makeSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (timer.unref) timer.unref();
  return controller.signal;
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Simple in-memory rate limiter: max 2 requests/second to Jupiter
let _lastRequest = 0;
async function _rateLimit() {
  const gap = 500 - (Date.now() - _lastRequest);
  if (gap > 0) await new Promise(r => setTimeout(r, gap));
  _lastRequest = Date.now();
}

async function _getQuote({ inputMint, outputMint, amountLamports, slippageBps = 5000 }) {
  await _rateLimit();
  const url = `${JUPITER_BASE}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${slippageBps}`;
  const res = await fetch(url, { signal: _makeSignal(30_000), headers: _jupHeaders() });
  if (res.status === 429) throw new Error('Jupiter rate limit');
  if (!res.ok) throw new Error(`Jupiter quote error: ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`Jupiter quote: ${data.error}`);
  if (!data.outAmount || data.outAmount === '0') throw new Error(`No liquidity for ${inputMint} → ${outputMint}`);
  return data;
}

/**
 * Fetch on-chain decimals for an SPL mint.
 */
async function getTokenDecimals(mintAddress) {
  const info = await config.connection.getParsedAccountInfo(new PublicKey(mintAddress));
  return info?.value?.data?.parsed?.info?.decimals ?? 6;
}

/**
 * Execute a SOL → token swap via Jupiter.
 *
 * @param {object} params
 * @param {import('@solana/web3.js').Keypair} params.devKeypair  - signing wallet (dev wallet)
 * @param {string}  params.outputMint         - destination token mint
 * @param {number}  params.amountLamports     - SOL to spend (in lamports)
 * @param {number}  [params.slippageBps=5000] - initial slippage tolerance
 * @returns {Promise<{outAmount: bigint, decimals: number, txid: string}>}
 */
async function swapSolToToken({ devKeypair, outputMint, amountLamports, slippageBps = 5000 }) {
  const swapId = Math.random().toString(36).slice(2, 8);
  logEvent('info', `[Jupiter ${swapId}] SOL → ${outputMint} | ${(amountLamports / 1e9).toFixed(6)} SOL`);

  const slippageSteps = [slippageBps, 7500, 10000, 15000];
  let lastErr;

  for (let attempt = 1; attempt <= slippageSteps.length; attempt++) {
    const currentSlippage = slippageSteps[attempt - 1];
    try {
      // 1. Get quote
      const quote = await _getQuote({
        inputMint:    SOL_MINT,
        outputMint,
        amountLamports,
        slippageBps:  currentSlippage,
      });

      // 2. Build swap transaction
      await _rateLimit();
      const swapRes = await fetch(`${JUPITER_BASE}/swap`, {
        method:  'POST',
        headers: _jupHeaders(),
        signal:  _makeSignal(30_000),
        body: JSON.stringify({
          quoteResponse:              quote,
          userPublicKey:              devKeypair.publicKey.toString(),
          wrapAndUnwrapSol:           true,
          dynamicComputeUnitLimit:    true,
          prioritizationFeeLamports:  10_000, // ~0.00001 SOL tip to land quickly
        }),
      });

      if (swapRes.status === 429) throw new Error('Jupiter rate limit on swap');
      if (!swapRes.ok) throw new Error(`Jupiter swap error: ${swapRes.status}`);

      const { swapTransaction } = await swapRes.json();
      if (!swapTransaction) throw new Error('No swap transaction returned');

      // 3. Sign and send
      const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
      tx.sign([devKeypair]);
      const txid = await config.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight:        false,
        preflightCommitment:  'confirmed',
        maxRetries:           3,
      });

      // 4. Confirm
      const { value: { err } } = await config.connection.confirmTransaction(
        txid, 'confirmed'
      );
      if (err) throw new Error(`Swap tx failed: ${JSON.stringify(err)}`);

      const outAmount = BigInt(quote.outAmount);
      const decimals  = await getTokenDecimals(outputMint);

      logEvent('info', `[Jupiter ${swapId}] Swap confirmed`, {
        txid,
        out: `${(Number(outAmount) / 10 ** decimals).toFixed(6)} (${outAmount} raw)`,
        slippageBps: currentSlippage,
        attempt,
      });

      return { outAmount, decimals, txid };

    } catch (e) {
      lastErr = e;
      const isSlippage = e.message.includes('ExceededSlippage') || e.message.includes('0x1774');
      const isRate     = e.message.includes('rate limit');
      const delayMs    = isRate ? 5000 * attempt : isSlippage ? 1000 : 500 * attempt;

      logEvent('warn', `[Jupiter ${swapId}] Attempt ${attempt} failed — ${e.message}`, {
        nextSlippage: slippageSteps[attempt] ?? 'none',
        delayMs,
      });

      if (attempt < slippageSteps.length) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }

  throw new Error(`Jupiter swap failed after ${slippageSteps.length} attempts: ${lastErr?.message}`);
}

module.exports = { swapSolToToken, getTokenDecimals, SOL_MINT };
