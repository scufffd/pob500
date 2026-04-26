'use strict';

/**
 * token-validator.js — gatekeeper for personalized reward token preferences.
 *
 * Mirrors the refi `validate-add` flow but adds RugCheck risk gating and a
 * "can-sell" round-trip quote so a buy quote alone can't sneak honeypots in.
 *
 * Returns a structured result so the frontend can show liquidity, score, and
 * any warnings inline next to the CA the user pasted.
 */

const { PublicKey } = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} = require('@solana/spl-token');

const config = require('./config');
const { logEvent } = require('./utils');

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_QUOTE_BASE = 'https://api.jup.ag/swap/v1/quote';
const RUGCHECK_BASE = process.env.RUGCHECK_API_BASE || 'https://api.rugcheck.xyz/v1';

// Tunables — can be overridden by .env without redeploy.
const MIN_LIQUIDITY_USD = parseFloat(process.env.REWARD_PREF_MIN_LIQUIDITY_USD || '5000');
const MIN_VOLUME_USD = parseFloat(process.env.REWARD_PREF_MIN_VOLUME_USD || '1000');
// Honeypot/round-trip probe amount. Hardcoded — should be small enough not to
// burn meaningful fees per validation but large enough that Jupiter returns
// a real route (sub-0.001 SOL quotes hit per-pool minimums on a lot of
// long-tail Printr pairs). Not exposed via env on purpose.
const PROBE_AMOUNT_SOL = 0.01;
const RUGCHECK_BLOCK_ABOVE = parseFloat(process.env.REWARD_PREF_RUGCHECK_BLOCK_ABOVE || '60000');
const RUGCHECK_WARN_ABOVE = parseFloat(process.env.REWARD_PREF_RUGCHECK_WARN_ABOVE || '20000');
const ROUNDTRIP_MIN_RECOVERY = parseFloat(process.env.REWARD_PREF_ROUNDTRIP_MIN_RECOVERY || '0.55');

function isValidPubkey(value) {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

async function detectTokenProgram(mint) {
  const info = await config.connection.getAccountInfo(mint);
  if (!info) throw new Error('mint_not_found');
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return { program: TOKEN_2022_PROGRAM_ID, label: 'Token-2022' };
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return { program: TOKEN_PROGRAM_ID, label: 'Token' };
  throw new Error('not_a_token_mint');
}

async function fetchMintInfo(mintBase58) {
  const mintPk = new PublicKey(mintBase58);
  const acct = await config.connection.getParsedAccountInfo(mintPk);
  if (!acct?.value) throw new Error('mint_not_found');
  const parsed = acct.value.data?.parsed?.info;
  if (!parsed) throw new Error('not_a_token_mint');
  const decimals = Number(parsed.decimals ?? 9);
  const supplyRaw = parsed.supply ? Number(parsed.supply) : 0;
  const owner = String(acct.value.owner?.toBase58?.() || '');
  return { decimals, supplyRaw, owner, mintPk };
}

async function fetchJupiterTokenList(mintBase58) {
  // Jupiter's tokens endpoint returns metadata for tradable mints. We use it
  // for the symbol/name fallback when the mint has no Token-2022 metadata
  // extension, mirroring how the refi token-validation endpoint did it.
  try {
    const res = await fetch(`https://lite-api.jup.ag/tokens/v1/token/${mintBase58}`, {
      timeout: 6000,
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json?.address) return null;
    return {
      symbol: json.symbol || null,
      name: json.name || null,
      logoURI: json.logoURI || null,
    };
  } catch {
    return null;
  }
}

async function jupiterQuote({ inputMint, outputMint, amount, slippageBps = 5000 }) {
  const url = `${JUPITER_QUOTE_BASE}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;
  const res = await fetch(url, { timeout: 15000 });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`jupiter_quote_${res.status}:${body.slice(0, 200)}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(`jupiter_quote_error:${data.error}`);
  if (!data.outAmount || data.outAmount === '0') throw new Error('no_route');
  return data;
}

async function fetchDexScreener(mintBase58) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mintBase58}`, {
      timeout: 8000,
    });
    if (!res.ok) return null;
    const json = await res.json();
    const pairs = (Array.isArray(json.pairs) ? json.pairs : [])
      .filter((p) => p.chainId === 'solana')
      .sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0));
    return pairs[0] || null;
  } catch {
    return null;
  }
}

async function fetchRugcheckSummary(mintBase58) {
  try {
    const res = await fetch(`${RUGCHECK_BASE}/tokens/${mintBase58}/report/summary`, {
      timeout: 8000,
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

/**
 * Validate a candidate reward mint and return a structured snapshot the
 * frontend (and the off-chain re-validation pass) can render.
 *
 * Throws an Error whose `.code` property is a stable machine-readable string
 * (e.g. `invalid_mint`, `rugcheck_extreme_risk`, `low_liquidity`) so the UI
 * can map them to friendly messages without parsing English.
 */
async function validateRewardMint(mintBase58) {
  if (!mintBase58 || !isValidPubkey(mintBase58)) {
    const e = new Error('Invalid mint address');
    e.code = 'invalid_mint';
    throw e;
  }
  if (mintBase58 === SOL_MINT) {
    // Always allow SOL as a personalized reward — no validation needed.
    return {
      mint: SOL_MINT,
      symbol: 'SOL',
      name: 'Solana',
      decimals: 9,
      tokenProgram: 'native',
      liquidityUsd: null,
      volume24hUsd: null,
      priceUsd: null,
      change24h: null,
      rugcheckScore: null,
      warnings: [],
      probe: null,
      ok: true,
      isStakeMint: false,
    };
  }
  const stakeMint = (process.env.POB_STAKE_MINT || '').trim();
  const isStakeMint = stakeMint && stakeMint === mintBase58;
  if (isStakeMint) {
    // Allow the stake mint as a personalized reward — this is an off-chain
    // auto-compound (swap SOL → POB500 → airdrop to wallet). It does NOT
    // touch the on-chain pool's reward registration, so the buyback-loop
    // concern that gates `add_reward_mint` does not apply here.
    //
    // Skip RugCheck/liquidity floors because (a) the worker already uses
    // these Jupiter routes every cycle as part of the auto-basket flow, so
    // routability is implicitly proven, and (b) blocking the project's own
    // token on a generic risk score would be silly.
    let mintInfo;
    try {
      mintInfo = await fetchMintInfo(mintBase58);
    } catch (e) {
      const err = new Error('Stake mint not found on Solana — POB_STAKE_MINT misconfigured?');
      err.code = e.message;
      throw err;
    }
    let programLabel;
    try {
      const det = await detectTokenProgram(mintInfo.mintPk);
      programLabel = det.label;
    } catch (e) {
      const err = new Error('Stake mint owner is not a token program');
      err.code = e.message;
      throw err;
    }
    // Best-effort metadata fetch so the UI can show a ticker/price even
    // though we never gate on these for the stake mint.
    const dex = await fetchDexScreener(mintBase58);
    return {
      mint: mintBase58,
      symbol: dex?.baseToken?.symbol || 'POB500',
      name: dex?.baseToken?.name || 'Proof of Belief',
      logoURI: null,
      decimals: mintInfo.decimals,
      tokenProgram: programLabel,
      supply: mintInfo.supplyRaw / Math.pow(10, mintInfo.decimals || 9),
      liquidityUsd: Number(dex?.liquidity?.usd || 0) || null,
      volume24hUsd: Number(dex?.volume?.h24 || 0) || null,
      priceUsd: dex?.priceUsd || null,
      change24h: dex?.priceChange?.h24 != null ? Number(dex.priceChange.h24) : null,
      rugcheckScore: null,
      rugcheckRisks: null,
      warnings: [{
        code: 'stake_mint_compound',
        message: 'POB500 selected as a personalized reward — this acts as auto-compound. Each cycle Faith buys POB500 for you and sends it to your wallet.',
      }],
      probe: null,
      ok: true,
      isStakeMint: true,
    };
  }

  let mintInfo;
  try {
    mintInfo = await fetchMintInfo(mintBase58);
  } catch (e) {
    const err = new Error(e.message === 'mint_not_found'
      ? 'Token mint not found on Solana'
      : 'Address is not a token mint');
    err.code = e.message;
    throw err;
  }

  let programLabel;
  try {
    const det = await detectTokenProgram(mintInfo.mintPk);
    programLabel = det.label;
  } catch (e) {
    const err = new Error(e.message === 'mint_not_found'
      ? 'Token mint not found on Solana'
      : 'Address is not a token mint');
    err.code = e.message;
    throw err;
  }

  const probeLamports = Math.round(PROBE_AMOUNT_SOL * 1e9);
  let buyQuote;
  try {
    buyQuote = await jupiterQuote({
      inputMint: SOL_MINT,
      outputMint: mintBase58,
      amount: probeLamports,
      slippageBps: 5000,
    });
  } catch (e) {
    const err = new Error('Jupiter found no route to buy this token');
    err.code = 'no_buy_route';
    err.detail = e.message;
    throw err;
  }

  const buyOut = BigInt(buyQuote.outAmount);
  let sellQuote;
  try {
    sellQuote = await jupiterQuote({
      inputMint: mintBase58,
      outputMint: SOL_MINT,
      amount: buyOut.toString(),
      slippageBps: 5000,
    });
  } catch (e) {
    const err = new Error('No sell route — token may be a honeypot');
    err.code = 'no_sell_route';
    err.detail = e.message;
    throw err;
  }
  const sellLamports = BigInt(sellQuote.outAmount || '0');
  const recoveryRatio = probeLamports > 0
    ? Number(sellLamports) / probeLamports
    : 0;

  if (recoveryRatio < ROUNDTRIP_MIN_RECOVERY) {
    const err = new Error(
      `Round-trip recovery ${(recoveryRatio * 100).toFixed(1)}% below ${(ROUNDTRIP_MIN_RECOVERY * 100).toFixed(0)}% threshold — likely honeypot or extreme tax`,
    );
    err.code = 'roundtrip_loss_too_high';
    err.detail = { recoveryRatio, threshold: ROUNDTRIP_MIN_RECOVERY };
    throw err;
  }

  const dex = await fetchDexScreener(mintBase58);
  const liquidityUsd = Number(dex?.liquidity?.usd || 0);
  const volume24hUsd = Number(dex?.volume?.h24 || 0);
  const priceUsd = dex?.priceUsd || null;
  const change24h = dex?.priceChange?.h24 != null ? Number(dex.priceChange.h24) : null;

  const warnings = [];
  if (liquidityUsd > 0 && liquidityUsd < MIN_LIQUIDITY_USD) {
    const err = new Error(`Liquidity ${liquidityUsd.toLocaleString()} USD below ${MIN_LIQUIDITY_USD.toLocaleString()} USD threshold`);
    err.code = 'low_liquidity';
    err.detail = { liquidityUsd, threshold: MIN_LIQUIDITY_USD };
    throw err;
  }
  if (liquidityUsd === 0) {
    warnings.push({
      code: 'no_dex_data',
      message: 'No DexScreener pair found yet — liquidity could not be confirmed',
    });
  }
  if (volume24hUsd > 0 && volume24hUsd < MIN_VOLUME_USD) {
    warnings.push({
      code: 'low_volume',
      message: `24h volume below ${MIN_VOLUME_USD.toLocaleString()} USD`,
    });
  }

  const rugcheck = await fetchRugcheckSummary(mintBase58);
  const rugcheckScore = rugcheck?.score_normalised ?? rugcheck?.score ?? null;
  if (rugcheckScore != null) {
    if (rugcheckScore >= RUGCHECK_BLOCK_ABOVE) {
      const err = new Error(`RugCheck risk score ${rugcheckScore} too high — token blocked`);
      err.code = 'rugcheck_extreme_risk';
      err.detail = {
        rugcheckScore,
        threshold: RUGCHECK_BLOCK_ABOVE,
        risks: Array.isArray(rugcheck?.risks) ? rugcheck.risks.slice(0, 5) : null,
      };
      throw err;
    }
    if (rugcheckScore >= RUGCHECK_WARN_ABOVE) {
      warnings.push({
        code: 'rugcheck_warning',
        message: `RugCheck score ${rugcheckScore} — review risks before saving`,
        risks: Array.isArray(rugcheck?.risks) ? rugcheck.risks.slice(0, 3) : null,
      });
    }
  } else {
    warnings.push({
      code: 'rugcheck_unavailable',
      message: 'RugCheck data unavailable — proceed with caution',
    });
  }

  // Resolve symbol: prefer DexScreener baseToken metadata, then Jupiter, then mint slice.
  const baseTokenSymbol = dex?.baseToken?.symbol || null;
  const baseTokenName = dex?.baseToken?.name || null;
  let symbol = baseTokenSymbol;
  let name = baseTokenName;
  let logoUrl = null;
  if (!symbol || !name) {
    const fallback = await fetchJupiterTokenList(mintBase58);
    if (fallback) {
      symbol = symbol || fallback.symbol;
      name = name || fallback.name;
      logoUrl = fallback.logoURI;
    }
  }

  const decimalsForOut = mintInfo.decimals;
  const outUi = Number(buyOut) / Math.pow(10, decimalsForOut || 9);
  const recoveryUi = Number(sellLamports) / 1e9;

  const result = {
    mint: mintBase58,
    symbol: symbol || mintBase58.slice(0, 4).toUpperCase(),
    name: name || symbol || mintBase58.slice(0, 6),
    logoURI: logoUrl,
    decimals: decimalsForOut,
    tokenProgram: programLabel,
    supply: mintInfo.supplyRaw / Math.pow(10, decimalsForOut || 9),
    liquidityUsd,
    volume24hUsd,
    priceUsd,
    change24h,
    rugcheckScore,
    rugcheckRisks: Array.isArray(rugcheck?.risks)
      ? rugcheck.risks.slice(0, 5).map((r) => ({
        name: r.name || r.label || null,
        level: r.level || r.severity || null,
        description: r.description || null,
      }))
      : null,
    warnings,
    probe: {
      probeSol: PROBE_AMOUNT_SOL,
      buyOutRaw: buyOut.toString(),
      buyOutUi: outUi,
      sellLamports: sellLamports.toString(),
      sellSolUi: recoveryUi,
      recoveryRatio,
      slippageBps: 5000,
    },
    ok: true,
  };

  logEvent('info', 'reward-pref token validated', {
    mint: mintBase58,
    symbol: result.symbol,
    liquidityUsd,
    rugcheckScore,
    recoveryRatio,
  });

  return result;
}

module.exports = {
  validateRewardMint,
  SOL_MINT,
  MIN_LIQUIDITY_USD,
  MIN_VOLUME_USD,
};
