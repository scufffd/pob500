'use strict';

/**
 * distribute.js — Proportional rewards distribution to token holders.
 *
 * Supports two modes:
 *   1. SOL-only (default): direct SystemProgram.transfer to all holders.
 *   2. Preference routing: each holder receives their chosen reward token
 *      (SOL or any SPL token) proportional to their share of supply.
 *      Non-SOL amounts are swapped via Jupiter before distribution.
 *      Holders without an ATA for a chosen token fall back to SOL.
 */

const {
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} = require('@solana/web3.js');
const bs58 = require('bs58');
const {
  createTransferCheckedInstruction,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} = require('@solana/spl-token');

const config = require('./config');
const { logEvent, withTimeout, retry, sleep, formatSol, lamportsToSol } = require('./utils');
const { getAccountInfoCached, getMultipleAccountsInfoChunked } = require('./rpc-account-cache');
const raydium = require('./raydium');
const jupiter = require('./jupiter');
const SOL_MINT = raydium.SOL_MINT;

/**
 * Returns TOKEN_2022_PROGRAM_ID or TOKEN_PROGRAM_ID based on the mint's on-chain owner.
 * All x-stock tokens (TSLAx, MSFTx, etc.) and many modern tokens are Token-2022.
 */
async function getTokenProgramId(mintPubkey) {
  const key = mintPubkey.toBase58();
  try {
    const info = await getAccountInfoCached(config.connection, mintPubkey);
    const programId = info?.owner?.equals(TOKEN_2022_PROGRAM_ID)
      ? TOKEN_2022_PROGRAM_ID
      : TOKEN_PROGRAM_ID;
    logEvent('info', `[TokenProgram] ${key.slice(0, 8)}… → ${programId.equals(TOKEN_2022_PROGRAM_ID) ? 'Token-2022' : 'Legacy SPL'}`);
    return programId;
  } catch {
    return TOKEN_PROGRAM_ID; // safe default
  }
}

/**
 * Try Raydium first (reachable), fall back to Jupiter if it fails.
 */
async function swapSolToToken(params) {
  try {
    return await raydium.swapSolToToken(params);
  } catch (rayErr) {
    logEvent('warn', `[Swap] Raydium failed — trying Jupiter fallback`, { error: rayErr.message });
    return await jupiter.swapSolToToken(params);
  }
}
const MAX_TRANSFERS_PER_TX     = 10;
const MAX_SPL_TRANSFERS_PER_TX = 5; // SPL instructions are heavier

// One-time wallet per recipient: fee buffer for one transfer tx; batch size for funding from dev
const ONE_TIME_WALLET_FEE_LAMPORTS = 5000;
const ONE_TIME_FUND_BATCH_SIZE     = 32; // fund this many one-time wallets per tx (under Solana tx limit)

// ── Platform fee constants ────────────────────────────────────────────────────

const MIN_DISTRIBUTE_LAMPORTS = Math.round(
  parseFloat(process.env.MIN_DISTRIBUTE_SOL || '0.05') * 1e9
);
const PLATFORM_FEE_PCT  = parseFloat(process.env.PLATFORM_FEE_PCT || '0.02');
const PLATFORM_WALLET   = process.env.PLATFORM_WALLET || null;

// ── Reward calculation ────────────────────────────────────────────────────────

/**
 * Calculate per-holder SOL rewards using integer division.
 * Any rounding remainder is given to the largest-share holder.
 */
function calculateRewards(holders, totalSupply, distributableLamports) {
  if (totalSupply === 0n || distributableLamports <= 0) return [];

  const qualified = [];
  let allocated = 0;

  for (const holder of holders) {
    const rewardLamports = Number(
      (BigInt(distributableLamports) * holder.balance) / totalSupply
    );
    if (rewardLamports < 1) continue;

    const sharePercent = (Number(holder.balance) / Number(totalSupply)) * 100;
    qualified.push({ ...holder, rewardLamports, sharePercent });
    allocated += rewardLamports;
  }

  if (qualified.length === 0) return [];

  const remainder = distributableLamports - allocated;
  if (remainder > 0) {
    const largest = qualified.reduce((m, h) => h.rewardLamports > m.rewardLamports ? h : m);
    largest.rewardLamports += remainder;
  }

  logEvent('info', 'Reward calculation complete', {
    totalHolders:     holders.length,
    qualifiedHolders: qualified.length,
    skipped:          holders.length - qualified.length,
    distributable:    formatSol(distributableLamports),
  });

  return qualified;
}

/**
 * Allocate lamports by arbitrary bigint weights (e.g. balance × tenure multiplier).
 * @param {Array<{ address: string, rewardWeight: bigint }>} holders
 */
function calculateRewardsByWeight(holders, distributableLamports) {
  const totalWeight = holders.reduce((s, h) => s + h.rewardWeight, 0n);
  if (totalWeight === 0n || distributableLamports <= 0) return [];

  const qualified = [];
  let allocated = 0;

  for (const holder of holders) {
    const rewardLamports = Number(
      (BigInt(distributableLamports) * holder.rewardWeight) / totalWeight
    );
    if (rewardLamports < 1) continue;

    const sharePercent = (Number(holder.rewardWeight) / Number(totalWeight)) * 100;
    qualified.push({ ...holder, rewardLamports, sharePercent });
    allocated += rewardLamports;
  }

  if (qualified.length === 0) return [];

  const remainder = distributableLamports - allocated;
  if (remainder > 0) {
    const largest = qualified.reduce((m, h) => h.rewardLamports > m.rewardLamports ? h : m);
    largest.rewardLamports += remainder;
  }

  logEvent('info', 'Reward calculation (weight) complete', {
    totalHolders: holders.length,
    qualifiedHolders: qualified.length,
    distributable: formatSol(distributableLamports),
  });

  return qualified;
}

// ── SOL batch transfer ────────────────────────────────────────────────────────

async function sendSolBatch(devKeypair, batch, opts = {}) {
  const tx = new Transaction();
  const priorityFeeSol = opts.priorityFeeSol !== undefined ? opts.priorityFeeSol : config.PRIORITY_FEE;
  const priorityMicroLamports = Math.round(priorityFeeSol * 1e9);
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }));

  for (const { address, rewardLamports } of batch) {
    tx.add(SystemProgram.transfer({
      fromPubkey: devKeypair.publicKey,
      toPubkey:   new PublicKey(address),
      lamports:   rewardLamports,
    }));
  }

  return retry(
    () => withTimeout(
      sendAndConfirmTransaction(config.connection, tx, [devKeypair]),
      config.CONFIRM_TIMEOUT_MS,
      `sendSolBatch (${batch.length} transfers)`
    ),
    { label: 'sendSolBatch', retries: 3, baseDelayMs: 2000 }
  );
}

// ── SPL token batch transfer ──────────────────────────────────────────────────

async function sendTokenBatch(devKeypair, batch, mintPubkey, decimals, programId) {
  const devAta = getAssociatedTokenAddressSync(mintPubkey, devKeypair.publicKey, true, programId);
  const tx     = new Transaction();
  const priorityMicroLamports = Math.round(config.PRIORITY_FEE * 1e9);
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }));

  for (const { holderAta, tokenAmount } of batch) {
    tx.add(createTransferCheckedInstruction(
      devAta,
      mintPubkey,
      holderAta,
      devKeypair.publicKey,
      BigInt(tokenAmount),
      decimals,
      [],
      programId,
    ));
  }

  return retry(
    () => withTimeout(
      sendAndConfirmTransaction(config.connection, tx, [devKeypair]),
      config.CONFIRM_TIMEOUT_MS,
      `sendTokenBatch (${batch.length} token transfers)`
    ),
    { label: 'sendTokenBatch', retries: 3, baseDelayMs: 2000 }
  );
}

// Solana rent-exempt minimum — imported from config to stay in sync.
const RENT_EXEMPT_MIN = config.SOLANA_MIN_RENT_EXEMPT_LAMPORTS;

// ── Pre-filter zero-balance accounts that would fail rent check ───────────────

/**
 * Filter out holders whose reward would leave their account below the
 * Solana rent-exempt minimum. Only checks accounts with small rewards
 * (< RENT_EXEMPT_MIN) to minimise RPC calls. Returns { safeHolders, skippedCount }.
 */
async function filterRentUnsafeHolders(holders, label) {
  const atRisk = holders.filter(h => h.rewardLamports < RENT_EXEMPT_MIN);
  if (atRisk.length === 0) return { safeHolders: holders, skippedCount: 0 };

  logEvent('info', `[${label}] Pre-checking ${atRisk.length} small-reward holder(s) for zero-balance wallets`);

  const pubkeys    = atRisk.map(h => new PublicKey(h.address));
  const balanceMap = {};

  for (let i = 0; i < pubkeys.length; i += 100) {
    try {
      const infos = await withTimeout(
        config.connection.getMultipleAccountsInfo(pubkeys.slice(i, i + 100)),
        config.NETWORK_TIMEOUT_MS,
        'getMultipleAccountsInfo(rent-check)'
      );
      pubkeys.slice(i, i + 100).forEach((pk, idx) => {
        balanceMap[pk.toBase58()] = infos[idx]?.lamports ?? 0;
      });
    } catch (e) {
      // If the pre-check itself fails, proceed without filtering —
      // individual-retry logic will catch rent errors per-holder.
      logEvent('warn', `[${label}] Rent pre-check failed — proceeding without filter`, { error: e.message });
      return { safeHolders: holders, skippedCount: 0 };
    }
  }

  const safeHolders = [];
  let skippedCount  = 0;

  for (const holder of holders) {
    if (holder.rewardLamports >= RENT_EXEMPT_MIN) {
      safeHolders.push(holder);
    } else {
      const currentBal = balanceMap[holder.address] ?? 0;
      if (currentBal + holder.rewardLamports >= RENT_EXEMPT_MIN) {
        safeHolders.push(holder); // existing SOL means they are above rent-exempt
      } else {
        skippedCount++;
      }
    }
  }

  if (skippedCount > 0) {
    logEvent('info', `[${label}] Skipped ${skippedCount} zero-balance holder(s) — reward below rent-exempt min. Lamports remain in wallet for next cycle.`);
  }

  return { safeHolders, skippedCount };
}

/**
 * Sweep remaining SOL from a one-time distributor wallet back to dev.
 * Returns true if sweep succeeded or balance was too low; false if sweep tx failed.
 */
async function sweepOneTimeWallet(keypair, devPublicKey, label) {
  const bal = await config.connection.getBalance(keypair.publicKey).catch(() => 0);
  if (bal <= ONE_TIME_WALLET_FEE_LAMPORTS) return true;
  const sweepLamports = bal - ONE_TIME_WALLET_FEE_LAMPORTS;
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey:   devPublicKey,
      lamports:   sweepLamports,
    })
  );
  try {
    await sendAndConfirmTransaction(config.connection, tx, [keypair], { skipPreflight: true });
    return true;
  } catch (e) {
    logEvent('warn', `[${label}] One-time wallet sweep failed`, {
      wallet: keypair.publicKey.toBase58().slice(0, 8),
      lamports: sweepLamports,
      error: e.message,
    });
    return false;
  }
}

/**
 * Execute SOL distribution using one one-time wallet per recipient (Bubblemaps unlink).
 * Each recipient is paid from a fresh keypair; dev only funds those keypairs.
 * Failed sends or sweeps leave keypairs in pendingDistributorKeypairs for recovery.
 */
async function executeSolDistributionOneTimePerRecipient(devKeypair, qualifiedHolders, label) {
  const { safeHolders, skippedCount } = await filterRentUnsafeHolders(qualifiedHolders, label);
  let successfulTransfers = 0;
  let failedTransfers      = skippedCount;
  let totalDistributed     = 0;
  const pendingRecovery    = [];

  const devPublicKey = devKeypair.publicKey;

  for (let i = 0; i < safeHolders.length; i += ONE_TIME_FUND_BATCH_SIZE) {
    const batch = safeHolders.slice(i, i + ONE_TIME_FUND_BATCH_SIZE);
    const keypairs = batch.map(() => Keypair.generate());

    // One tx: dev funds all one-time wallets in this batch (use lower priority to keep cost down)
    const fundTx = new Transaction();
    const priorityMicroLamports = Math.round(config.ONE_TIME_PRIORITY_FEE * 1e9);
    fundTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }));
    for (let j = 0; j < batch.length; j++) {
      fundTx.add(SystemProgram.transfer({
        fromPubkey: devPublicKey,
        toPubkey:   keypairs[j].publicKey,
        lamports:   batch[j].rewardLamports + ONE_TIME_WALLET_FEE_LAMPORTS,
      }));
    }

    try {
      await retry(
        () => withTimeout(
          sendAndConfirmTransaction(config.connection, fundTx, [devKeypair]),
          config.CONFIRM_TIMEOUT_MS,
          `fund one-time batch (${batch.length})`
        ),
        { label: 'fundOneTimeBatch', retries: 3, baseDelayMs: 2000 }
      );
    } catch (fundErr) {
      logEvent('error', `[${label}] Fund batch failed — skipping ${batch.length} holder(s)`, { error: fundErr.message });
      failedTransfers += batch.length;
      if (i + ONE_TIME_FUND_BATCH_SIZE < safeHolders.length) await sleep(500);
      continue;
    }

    // Persist keypairs for recovery (if we crash or sweep fails)
    for (let j = 0; j < keypairs.length; j++) {
      pendingRecovery.push({
        publicKey:       keypairs[j].publicKey.toBase58(),
        privateKeyBase58: bs58.encode(keypairs[j].secretKey),
      });
    }

    // Each one-time wallet pays one holder, then we sweep
    for (let j = 0; j < batch.length; j++) {
      const kp = keypairs[j];
      const holder = batch[j];
      try {
        await sendSolBatch(kp, [holder], { priorityFeeSol: config.ONE_TIME_PRIORITY_FEE });
        successfulTransfers++;
        totalDistributed += holder.rewardLamports;
      } catch (sendErr) {
        logEvent('error', `[${label}] One-time send failed`, { to: holder.address.slice(0, 8), error: sendErr.message });
        failedTransfers++;
      }

      const swept = await sweepOneTimeWallet(kp, devPublicKey, label);
      if (swept) {
        const idx = pendingRecovery.findIndex(p => p.publicKey === kp.publicKey.toBase58());
        if (idx !== -1) pendingRecovery.splice(idx, 1);
      }
    }

    if (i + ONE_TIME_FUND_BATCH_SIZE < safeHolders.length) await sleep(300);
  }

  return {
    successfulTransfers,
    failedTransfers,
    totalDistributed,
    pendingDistributorKeypairs: pendingRecovery,
  };
}

// ── Execute SOL distribution ──────────────────────────────────────────────────

async function executeSolDistribution(devKeypair, qualifiedHolders, label) {
  let successfulTransfers = 0;
  let failedTransfers     = 0;
  let totalDistributed    = 0;

  // Filter out zero-balance wallets that would fail Solana's rent-exempt check.
  const { safeHolders, skippedCount } = await filterRentUnsafeHolders(qualifiedHolders, label);
  failedTransfers += skippedCount; // count skipped as "failed" so wallet balance stays accurate

  for (let i = 0; i < safeHolders.length; i += MAX_TRANSFERS_PER_TX) {
    const batch     = safeHolders.slice(i, i + MAX_TRANSFERS_PER_TX);
    const batchNum  = Math.floor(i / MAX_TRANSFERS_PER_TX) + 1;
    const totalBatches = Math.ceil(safeHolders.length / MAX_TRANSFERS_PER_TX);

    logEvent('info', `SOL batch ${batchNum}/${totalBatches} for ${label}`, {
      batchSize:  batch.length,
      batchTotal: formatSol(batch.reduce((s, h) => s + h.rewardLamports, 0)),
    });

    try {
      const sig = await sendSolBatch(devKeypair, batch);
      logEvent('info', `SOL batch ${batchNum}/${totalBatches} confirmed`, { signature: sig });
      successfulTransfers += batch.length;
      totalDistributed    += batch.reduce((s, h) => s + h.rewardLamports, 0);
    } catch (err) {
      logEvent('error', `SOL batch ${batchNum}/${totalBatches} failed`, { error: err.message });
      failedTransfers += batch.length;
      // Retry individually on batch failure
      for (const holder of batch) {
        try {
          await sendSolBatch(devKeypair, [holder]);
          successfulTransfers++;
          failedTransfers--;
          totalDistributed += holder.rewardLamports;
        } catch (indErr) {
          // A rent error on individual retry is a permanent skip for this cycle
          if (indErr.message.includes('insufficient funds for rent')) {
            logEvent('info', 'SOL transfer skipped — zero-balance recipient, reward below rent-exempt min', {
              address: holder.address.slice(0, 8),
              rewardLamports: holder.rewardLamports,
            });
          } else {
            logEvent('error', 'Individual SOL retry failed', { address: holder.address, error: indErr.message });
          }
        }
      }
    }

    if (i + MAX_TRANSFERS_PER_TX < safeHolders.length) await sleep(500);
  }

  return { successfulTransfers, failedTransfers, totalDistributed };
}

// ── Create missing ATAs in batches ────────────────────────────────────────────

const MAX_ATA_CREATES_PER_TX = 4; // createATA instruction is ~50 bytes each

/**
 * Create ATAs for a batch of holders.
 * Returns { failedAddresses: Set<string>, createdAddresses: Set<string> }
 */
async function createMissingAtas(devKeypair, mintPubkey, needsAta, label, programId) {
  if (needsAta.length === 0) return { failedAddresses: new Set(), createdAddresses: new Set() };
  const progLabel = programId?.equals(TOKEN_2022_PROGRAM_ID) ? 'Token-2022' : 'SPL';
  logEvent('info', `[${label}] Creating ${needsAta.length} missing ATA(s) (${progLabel}, dev wallet pays rent)`);

  const failedAddresses  = new Set();
  const createdAddresses = new Set();

  for (let i = 0; i < needsAta.length; i += MAX_ATA_CREATES_PER_TX) {
    const batch = needsAta.slice(i, i + MAX_ATA_CREATES_PER_TX);
    const tx    = new Transaction();
    const priorityMicroLamports = Math.round(config.PRIORITY_FEE * 1e9);
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }));

    for (const { address, ataAddr } of batch) {
      tx.add(createAssociatedTokenAccountInstruction(
        devKeypair.publicKey,       // payer
        ataAddr,                    // associated token account
        new PublicKey(address),     // owner
        mintPubkey,                 // mint
        programId,                  // token program (Token-2022 or legacy SPL)
      ));
    }

    try {
      const sig = await retry(
        () => withTimeout(
          sendAndConfirmTransaction(config.connection, tx, [devKeypair]),
          config.CONFIRM_TIMEOUT_MS,
          `createATAs (batch ${i / MAX_ATA_CREATES_PER_TX + 1})`
        ),
        { label: 'createATAs', retries: 2, baseDelayMs: 1500 }
      );
      logEvent('info', `[${label}] ATA creation batch confirmed`, { sig, count: batch.length });
      for (const { address } of batch) createdAddresses.add(address);
    } catch (err) {
      logEvent('error', `[${label}] ATA creation batch failed — marking holders for fallback`, { error: err.message });
      for (const { address } of batch) failedAddresses.add(address);
    }

    if (i + MAX_ATA_CREATES_PER_TX < needsAta.length) await sleep(500);
  }

  return { failedAddresses, createdAddresses };
}

// ── Execute token (SPL) distribution for one token group ─────────────────────

/**
 * Swap SOL → token, optionally create missing ATAs, distribute tokens.
 *
 * @param {Keypair}  devKeypair
 * @param {string}   outputMint
 * @param {Array}    holders          - { address, rewardLamports }
 * @param {string}   label
 * @param {boolean}  [autoCreateAtas] - create ATAs for holders that don't have one (default true)
 * @param {object}   [ataHistory]     - { "<address>": <creationCount> } persisted blacklist
 * @returns {{ successCount, failCount, solFallbackHolders, burnedAtaHolders, ataHistoryUpdates, distributedLamports }}
 */
async function executeTokenGroupDistribution(devKeypair, outputMint, holders, label, autoCreateAtas = true, ataHistory = {}) {
  const totalSolToSwap = holders.reduce((s, h) => s + h.rewardLamports, 0);
  logEvent('info', `[${label}] Token distribution: mint=${outputMint} | ${holders.length} holder(s) | ${formatSol(totalSolToSwap)}`);

  const mintPubkey  = new PublicKey(outputMint);

  // Detect Token-2022 vs legacy SPL — critical for correct ATA derivation & creation
  const programId = await getTokenProgramId(mintPubkey);

  const withAta            = [];
  const needsAta           = []; // address + ataAddr, will be created
  const burnedAtaHolders   = []; // we created their ATA before but they burned it → SOL fallback
  const permanentSolFallback = []; // ATA creation disabled or lookup failed
  const ataHistoryUpdates  = {};  // incremental changes to persist after cycle

  // ── Step 1: ATA check (batched getMultipleAccounts — one RPC per ~99 ATAs) ──
  const holderRows = [];
  for (const holder of holders) {
    try {
      const holderPub = new PublicKey(holder.address);
      const ataAddr = getAssociatedTokenAddressSync(mintPubkey, holderPub, true, programId);
      holderRows.push({ holder, holderPub, ataAddr });
    } catch (e) {
      logEvent('warn', `[${label}] ATA derive failed for ${holder.address.slice(0, 8)}: ${e.message}`);
      permanentSolFallback.push(holder);
    }
  }
  const ataAddrs = holderRows.map((r) => r.ataAddr);
  const ataInfos = ataAddrs.length
    ? await getMultipleAccountsInfoChunked(config.connection, ataAddrs, 'confirmed')
    : [];
  for (let i = 0; i < holderRows.length; i++) {
    const { holder, ataAddr } = holderRows[i];
    const info = ataInfos[i];
    try {
      if (info) {
        withAta.push({ ...holder, holderAta: ataAddr });
      } else if ((ataHistory[holder.address] || 0) >= 1) {
        logEvent('warn', `[${label}] Holder burned their ATA — SOL fallback (blacklisted)`, {
          holder: holder.address.slice(0, 8),
          creations: ataHistory[holder.address],
        });
        burnedAtaHolders.push(holder);
      } else if (autoCreateAtas) {
        logEvent('info', `[${label}] Holder needs ATA — will create`, { holder: holder.address.slice(0, 8) });
        needsAta.push({ address: holder.address, ataAddr });
        withAta.push({ ...holder, holderAta: ataAddr });
      } else {
        logEvent('info', `[${label}] No ATA — SOL fallback`, { holder: holder.address.slice(0, 8) });
        permanentSolFallback.push(holder);
      }
    } catch (e) {
      logEvent('warn', `[${label}] ATA lookup failed for ${holder.address.slice(0, 8)}: ${e.message}`);
      permanentSolFallback.push(holder);
    }
  }

  logEvent('info', `[${label}] ATA check: ${withAta.length} ready, ${needsAta.length} to create, ${burnedAtaHolders.length} blacklisted (burned), ${permanentSolFallback.length} other fallback`);

  if (withAta.length === 0) {
    logEvent('warn', `[${label}] No holders can receive ${outputMint} — full SOL fallback`);
    return { successCount: 0, failCount: 0, solFallbackHolders: [...burnedAtaHolders, ...permanentSolFallback], burnedAtaHolders, ataHistoryUpdates, distributedLamports: 0 };
  }

  // ── Step 1.5: 50/50 ATA split ─────────────────────────────────────────────
  // When there are both existing-ATA holders and new-ATA holders, split the
  // reward pool 50/50 between the two groups.  This caps ATA-creation overhead
  // to half the pool per cycle and ensures existing holders are never penalised
  // by waiting for (or subsidising) new-ATA creation.
  // If only one group exists the full pool stays with that group unchanged.
  if (needsAta.length > 0 && withAta.length > 0) {
    const needsAtaAddrs = new Set(needsAta.map(n => n.address));
    const existingGroup = withAta.filter(h => !needsAtaAddrs.has(h.address));
    const newAtaGroup   = withAta.filter(h =>  needsAtaAddrs.has(h.address));

    if (existingGroup.length > 0 && newAtaGroup.length > 0) {
      const totalLamports   = withAta.reduce((s, h) => s + h.rewardLamports, 0);
      const halfLamports    = Math.floor(totalLamports / 2);
      const existingNatural = existingGroup.reduce((s, h) => s + h.rewardLamports, 0);
      const newNatural      = newAtaGroup.reduce((s, h) => s + h.rewardLamports, 0);

      // Scale each group to exactly 50% of the total pool
      for (const h of existingGroup) {
        h.rewardLamports = Math.max(1, Math.round(h.rewardLamports * halfLamports / existingNatural));
      }
      for (const h of newAtaGroup) {
        h.rewardLamports = Math.max(1, Math.round(h.rewardLamports * halfLamports / newNatural));
      }

      logEvent('info', `[${label}] ATA 50/50 split applied`, {
        existingHolders: existingGroup.length,
        newAtaHolders:   newAtaGroup.length,
        existingPool:    formatSol(halfLamports),
        newAtaPool:      formatSol(halfLamports),
        totalPool:       formatSol(totalLamports),
      });
    }
  }

  // ── Step 2: Create missing ATAs (before the swap so they exist when tokens arrive) ──
  if (needsAta.length > 0) {
    const { failedAddresses, createdAddresses } = await createMissingAtas(devKeypair, mintPubkey, needsAta, label, programId);

    // Record successful creations in history (so future cycles can detect burns)
    for (const addr of createdAddresses) {
      ataHistoryUpdates[addr] = 1;
    }

    if (failedAddresses.size > 0) {
      const confirmed = withAta.filter(h => !failedAddresses.has(h.address));
      permanentSolFallback.push(...withAta.filter(h => failedAddresses.has(h.address)));
      withAta.length = 0;
      withAta.push(...confirmed);
      logEvent('info', `[${label}] ATA results: ${confirmed.length} ok, ${failedAddresses.size} failed`);
    } else {
      logEvent('info', `[${label}] Created ${createdAddresses.size} ATA(s) successfully`);
    }
  }

  if (withAta.length === 0) {
    logEvent('warn', `[${label}] All ATA creations failed — full SOL fallback`);
    return { successCount: 0, failCount: 0, solFallbackHolders: [...burnedAtaHolders, ...permanentSolFallback], burnedAtaHolders, ataHistoryUpdates, distributedLamports: 0 };
  }

  // ── Step 3: Jupiter swap ───────────────────────────────────────────────────
  const solToSwap = withAta.reduce((s, h) => s + h.rewardLamports, 0);
  logEvent('info', `[${label}] Requesting Raydium swap: ${formatSol(solToSwap)} SOL → ${outputMint}`);

  let swapResult;
  try {
    swapResult = await swapSolToToken({ devKeypair, outputMint, amountLamports: solToSwap });
  } catch (swapErr) {
    logEvent('error', `[${label}] Swap failed for ${outputMint} — all holders moved to fallback`, {
      error: swapErr.message,
      hint: swapErr.message.includes('No liquidity') || swapErr.message.includes('no liquidity')
        ? 'Token has no liquidity on Raydium/Jupiter — try a different reward token'
        : undefined,
    });
    return { successCount: 0, failCount: 0, solFallbackHolders: [...burnedAtaHolders, ...permanentSolFallback, ...withAta], burnedAtaHolders, ataHistoryUpdates, distributedLamports: 0 };
  }

  const { outAmount: totalTokenAmount, decimals } = swapResult;
  logEvent('info', `[${label}] Swap confirmed: ${formatSol(solToSwap)} → ${totalTokenAmount} raw tokens (decimals: ${decimals})`);

  // ── Step 4: Distribute tokens proportionally ───────────────────────────────
  let successCount = 0;
  let failCount    = 0;
  const totalSolForAta = withAta.reduce((s, h) => s + h.rewardLamports, 0);
  let tokenAllocated = 0n;
  const tokenBatch = withAta.map((holder, idx) => {
    const isLast = idx === withAta.length - 1;
    const share  = isLast
      ? totalTokenAmount - tokenAllocated
      : (totalTokenAmount * BigInt(holder.rewardLamports)) / BigInt(totalSolForAta);
    tokenAllocated += share;
    return { ...holder, tokenAmount: share };
  }).filter(h => h.tokenAmount > 0n);

  for (let i = 0; i < tokenBatch.length; i += MAX_SPL_TRANSFERS_PER_TX) {
    const batch    = tokenBatch.slice(i, i + MAX_SPL_TRANSFERS_PER_TX);
    const batchNum = Math.floor(i / MAX_SPL_TRANSFERS_PER_TX) + 1;
    const totalBatches = Math.ceil(tokenBatch.length / MAX_SPL_TRANSFERS_PER_TX);
    try {
      const sig = await sendTokenBatch(devKeypair, batch, mintPubkey, decimals, programId);
      logEvent('info', `[${label}] Token batch ${batchNum}/${totalBatches} confirmed`, { sig, count: batch.length });
      successCount += batch.length;
    } catch (err) {
      logEvent('error', `[${label}] Token batch ${batchNum}/${totalBatches} failed`, { error: err.message });
      failCount += batch.length;
      for (const holder of batch) {
        try {
          await sendTokenBatch(devKeypair, [holder], mintPubkey, decimals, programId);
          successCount++;
          failCount--;
        } catch (indErr) {
          logEvent('error', `[${label}] Individual token retry failed`, { address: holder.address.slice(0, 8), error: indErr.message });
        }
      }
    }
    if (i + MAX_SPL_TRANSFERS_PER_TX < tokenBatch.length) await sleep(500);
  }

  return {
    successCount,
    failCount,
    solFallbackHolders: permanentSolFallback,
    burnedAtaHolders,
    ataHistoryUpdates,
    distributedLamports: solToSwap,
  };
}

module.exports = {
  swapSolToToken,
  calculateRewards,
  calculateRewardsByWeight,
  executeTokenGroupDistribution,
  executeSolDistribution,
  sweepOneTimeWallet,
  SOL_MINT,
};
