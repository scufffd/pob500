'use strict';

/**
 * Fetch token holders via the Helius DAS API.
 *
 * Returns every wallet that holds at least MIN_HOLDER_BALANCE raw token units,
 * excluding:
 *  – PDAs (program-derived addresses — liquidity pools, vaults, etc.)
 *  – the token's dev wallet (the creator shouldn't reward themselves)
 */

const { PublicKey } = require('@solana/web3.js');
const { Helius } = require('helius-sdk');
const config = require('./config');
const { logEvent, withTimeout, sleep } = require('./utils');

// Lazy-initialise the Helius client so we don't crash on startup if the key
// hasn't been set yet (e.g. during unit tests).
let _helius = null;
function getHelius() {
  if (!_helius) {
    if (!config.HELIUS_API_KEY) throw new Error('HELIUS_API_KEY is required to fetch token holders');
    _helius = new Helius(config.HELIUS_API_KEY);
  }
  return _helius;
}

/**
 * Fetch all holders for a given token mint.
 *
 * @param {object} params
 * @param {string} params.mint             - token mint address
 * @param {string} [params.excludeWallet]  - wallet to exclude (dev wallet)
 * @param {bigint} [params.minBalance]     - minimum raw token balance (default: config.MIN_HOLDER_BALANCE)
 * @returns {Promise<{ holders: Array<{address: string, balance: bigint}>, totalBalance: bigint }>}
 */
async function getHolders({ mint, excludeWallet, minBalance = config.MIN_HOLDER_BALANCE }) {
  const helius = getHelius();

  logEvent('info', 'Fetching token holders via Helius DAS API', {
    mint,
    minBalance: minBalance.toString(),
    excludeWallet: excludeWallet ?? 'none',
  });

  const holders = [];
  const seen = new Set();
  let cursor = null;
  let page = 0;
  let skipped = 0;

  while (true) {
    let tokenAccounts;
    try {
      const response = await withTimeout(
        helius.rpc.getTokenAccounts({
          mint,
          limit: 1000,
          cursor,
          options: { showZeroBalance: false },
        }),
        config.NETWORK_TIMEOUT_MS,
        `Helius getTokenAccounts page ${page + 1}`
      );

      tokenAccounts = response.token_accounts || response.result || [];

      if (!Array.isArray(tokenAccounts) || tokenAccounts.length === 0) {
        logEvent('info', `No more token accounts after ${page} page(s)`, { mint });
        break;
      }

      for (const account of tokenAccounts) {
        const owner = account.owner;
        const balance = BigInt(account.amount ?? 0);

        // Skip duplicates
        if (seen.has(owner)) { skipped++; continue; }

        // Skip PDAs (liquidity pools, vaults, bonding curves)
        let pubkey;
        try {
          pubkey = new PublicKey(owner);
        } catch (_) {
          skipped++;
          logEvent('warn', 'Invalid owner address, skipping', { owner });
          continue;
        }

        if (!PublicKey.isOnCurve(pubkey.toBuffer())) {
          skipped++;
          logEvent('debug', 'Skipping PDA', { owner });
          continue;
        }

        // Skip the dev wallet
        if (excludeWallet && owner === excludeWallet) {
          skipped++;
          continue;
        }

        // Skip wallets below minimum balance
        if (balance < minBalance) {
          skipped++;
          continue;
        }

        seen.add(owner);
        holders.push({ address: owner, balance });
      }

      logEvent('info', `Fetched page ${page + 1}`, {
        accounts: tokenAccounts.length,
        qualifyingHolders: holders.length,
        skipped,
      });

      cursor = response.cursor;
      page++;

      if (!cursor || tokenAccounts.length < 1000) break;

      // Brief pause between pages to respect rate limits
      await sleep(200);

    } catch (err) {
      if (err.message?.includes('429')) {
        logEvent('warn', `Rate limit hit on page ${page + 1}, waiting 2s`, { mint });
        await sleep(2000);
        continue; // retry same page
      }
      if (err.message?.includes('timeout')) {
        logEvent('warn', `Timeout on page ${page + 1}, retrying`, { mint });
        await sleep(1000);
        continue;
      }
      logEvent('error', `Error fetching holders on page ${page + 1}, stopping`, { error: err.message });
      break;
    }
  }

  const totalBalance = holders.reduce((sum, h) => sum + h.balance, 0n);

  logEvent('info', 'Holder fetch complete', {
    mint,
    holderCount: holders.length,
    totalBalance: totalBalance.toString(),
    pagesFetched: page,
    skipped,
  });

  return { holders, totalBalance };
}

/**
 * Get the total circulating supply of a token using the Solana RPC.
 * This includes all token accounts (including PDAs and the dev wallet),
 * so it represents the full on-chain supply.
 *
 * @param {string} mint
 * @returns {Promise<bigint>}
 */
async function getTotalSupply(mint) {
  try {
    const result = await withTimeout(
      config.connection.getTokenSupply(new PublicKey(mint)),
      config.NETWORK_TIMEOUT_MS,
      'getTokenSupply'
    );
    return BigInt(result.value.amount);
  } catch (err) {
    logEvent('error', 'Failed to fetch total supply', { mint, error: err.message });
    throw err;
  }
}

module.exports = { getHolders, getTotalSupply };
