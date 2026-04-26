'use strict';

/**
 * personalized-distribute.js — off-pool personalized reward routing.
 *
 * Three-phase architecture (plan → swap → batch):
 *
 *   1. PLAN
 *      - Snapshot every open StakePosition, group by owner, compute each
 *        custom-pref wallet's pro-rata slice, then sub-allocate that slice
 *        across the wallet's chosen mints. Output is a flat list of
 *        `(wallet, mint, lamports, symbol, decimals)` entries.
 *      - Pre-spend revalidation runs *per unique mint* (not per allocation),
 *        so a popular mint chosen by many wallets is only checked once.
 *
 *   2. SWAP (aggregated)
 *      - For each unique non-SOL mint, swap the SUM of all entry lamports in
 *        a single Jupiter transaction. The output is then distributed to
 *        recipients pro-rata to their lamport contribution.
 *      - If a mint's swap fails, every entry for that mint is converted into
 *        a SOL-fallback entry — they get plain SOL instead of the token.
 *      - This collapses N×M swaps into ~M swaps and gets better routes.
 *
 *   3. BATCH TRANSFER
 *      - SOL transfers: one System.transfer per recipient, packed into txs
 *        until the serialized message hits a safety margin (~1200 bytes).
 *      - SPL transfers per mint: one ATA-create-idempotent + one
 *        transferChecked per recipient, again greedy-packed.
 *      - Each batch tx writes one ledger row per recipient with a shared
 *        `signature`. On batch failure every recipient lands in `skipped`
 *        with the same reason.
 *
 * Why off-pool?
 *   The on-chain pool can only pay out registered RewardMints to every
 *   staker pro-rata. Letting users opt into arbitrary mints via the pool
 *   would force every other staker to pay rent for those mints' checkpoints
 *   and pollute their reward list. Direct airdrop to the user's ATA keeps
 *   the on-chain accounting clean and isolates each user's choice.
 */

const fs = require('fs');
const path = require('path');
const {
  PublicKey,
  SystemProgram,
  Transaction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} = require('@solana/spl-token');

const config = require('./config');
const { logEvent } = require('./utils');
const { swapSolToToken } = require('./distribute');
const { resolveStakingConfig } = require('./stake-distribute');
const {
  listAllPreferences,
  markAllocationFailure,
  SOL_MINT,
} = require('./reward-prefs');
const { validateRewardMint } = require('./token-validator');

const PAYOUT_LEDGER = process.env.PERSONALIZED_PAYOUT_LEDGER
  || path.join(__dirname, '..', 'data', 'personalized-payouts.jsonl');

// Floor below which we skip a wallet entirely. Default 0.000001 SOL so even
// the smallest stakers still get something. Note: SPL swaps under ~0.001 SOL
// often hit Jupiter pool minimums — those entries fall back to SOL transfer.
const MIN_PERSONAL_SLICE_LAMPORTS = parseInt(
  process.env.PERSONAL_MIN_SLICE_LAMPORTS || '1000', // 0.000001 SOL
  10,
);
const REVALIDATE_BEFORE_SPEND = String(process.env.PERSONAL_REVALIDATE_BEFORE_SPEND || '1') === '1';
const SWAP_SLIPPAGE_BPS = parseInt(process.env.PERSONAL_SWAP_SLIPPAGE_BPS || '300', 10);

// Solana hard caps a packet at 1232 bytes; we keep a 32-byte margin.
const TX_BYTE_LIMIT = 1200;

function appendLedger(rows) {
  if (!rows || rows.length === 0) return;
  fs.mkdirSync(path.dirname(PAYOUT_LEDGER), { recursive: true });
  const list = Array.isArray(rows) ? rows : [rows];
  fs.appendFileSync(PAYOUT_LEDGER, list.map((r) => `${JSON.stringify(r)}\n`).join(''));
}

async function detectTokenProgram(mintPk) {
  const info = await config.connection.getAccountInfo(mintPk);
  if (!info) throw new Error('mint_not_found');
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  throw new Error('not_a_token_mint');
}

async function readAtaBalanceRaw(ata) {
  try {
    const info = await config.connection.getTokenAccountBalance(ata);
    return BigInt(info.value.amount);
  } catch {
    return 0n;
  }
}

/**
 * Snapshot every open StakePosition for the active pool and group by owner.
 */
async function snapshotStakers() {
  const cfg = resolveStakingConfig();
  if (!cfg.configured) return null;

  const anchor = require('@coral-xyz/anchor');
  const idlPath = path.join(__dirname, '..', '..', 'staking-sdk', 'src', 'idl.json');
  const idl = require(idlPath);
  const customIdl = { ...idl, address: cfg.programId.toBase58() };
  const wallet = new anchor.Wallet(anchor.web3.Keypair.generate());
  const provider = new anchor.AnchorProvider(config.stakeConnection, wallet, {
    commitment: 'confirmed',
  });
  const program = new anchor.Program(customIdl, provider);

  const positions = await program.account.stakePosition.all([
    { memcmp: { offset: 8 + 1, bytes: cfg.pool.toBase58() } },
  ]);
  const open = positions.filter((p) => !p.account.closed);
  const byOwner = new Map();
  let totalEffective = 0n;
  for (const p of open) {
    const owner = p.account.owner.toBase58();
    const effective = BigInt(p.account.effective?.toString?.() ?? p.account.effective ?? '0');
    if (effective === 0n) continue;
    totalEffective += effective;
    if (!byOwner.has(owner)) {
      byOwner.set(owner, { owner, effective: 0n, positions: 0 });
    }
    const rec = byOwner.get(owner);
    rec.effective += effective;
    rec.positions += 1;
  }
  return { totalEffective, stakers: Array.from(byOwner.values()) };
}

function effectiveShareLamports(distLamports, ownerEffective, totalEffective) {
  if (totalEffective === 0n || ownerEffective === 0n) return 0;
  const share = (BigInt(distLamports) * ownerEffective) / totalEffective;
  return Number(share);
}

function buildPriorityIx() {
  if (!config.PRIORITY_FEE) return null;
  return ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: Math.max(1, Math.round(config.PRIORITY_FEE * 1e9)),
  });
}

/**
 * Greedy-pack instructions into transactions whose serialized size stays
 * under TX_BYTE_LIMIT. Each tx gets a fresh recent blockhash + the priority
 * fee instruction at the front.
 */
async function packIntoTxs(instructionGroups, treasury) {
  if (instructionGroups.length === 0) return [];
  const { blockhash } = await config.connection.getLatestBlockhash('confirmed');

  const fitTest = (ixs) => {
    const t = new Transaction({ feePayer: treasury.publicKey, recentBlockhash: blockhash });
    for (const ix of ixs) t.add(ix);
    try {
      const len = t.serialize({ verifySignatures: false, requireAllSignatures: false }).length;
      return len <= TX_BYTE_LIMIT;
    } catch {
      return false;
    }
  };

  const priorityIx = buildPriorityIx();
  const baseIxs = priorityIx ? [priorityIx] : [];

  const txs = [];
  let cur = { ixs: [...baseIxs], groupRefs: [] };
  for (const group of instructionGroups) {
    const candidateIxs = [...cur.ixs, ...group.ixs];
    if (fitTest(candidateIxs) || cur.ixs.length === baseIxs.length) {
      cur.ixs = candidateIxs;
      cur.groupRefs.push(group);
    } else {
      txs.push(cur);
      cur = { ixs: [...baseIxs, ...group.ixs], groupRefs: [group] };
    }
  }
  if (cur.groupRefs.length > 0) txs.push(cur);

  return txs.map((entry) => {
    const tx = new Transaction({ feePayer: treasury.publicKey, recentBlockhash: blockhash });
    for (const ix of entry.ixs) tx.add(ix);
    return { tx, groupRefs: entry.groupRefs };
  });
}

async function sendBatch({ tx, treasury }) {
  return sendAndConfirmTransaction(config.connection, tx, [treasury], {
    commitment: 'confirmed',
    skipPreflight: false,
  });
}

/**
 * @param {object} opts
 * @param {import('@solana/web3.js').Keypair} opts.treasury
 * @param {number} opts.distributableLamports
 * @param {boolean} [opts.dryRun]
 * @returns {Promise<{
 *   personalizedLamports: number,
 *   residualLamports: number,
 *   payouts: Array,
 *   skipped: Array,
 *   swaps: Array,
 *   solFallbacks: Array,
 * }>}
 */
async function runPersonalizedSpend({ treasury, distributableLamports, dryRun = false } = {}) {
  if (distributableLamports <= 0) {
    return emptyResult(0);
  }

  const allPrefs = listAllPreferences();
  const customWallets = Object.entries(allPrefs)
    .filter(([, rec]) => rec.mode === 'custom' && Array.isArray(rec.allocations) && rec.allocations.length > 0);
  if (customWallets.length === 0) {
    return emptyResult(distributableLamports);
  }

  const snapshot = await snapshotStakers();
  if (!snapshot || snapshot.totalEffective === 0n) {
    return emptyResult(distributableLamports);
  }

  const stakerByOwner = new Map(snapshot.stakers.map((s) => [s.owner, s]));
  const cycleStartedAt = new Date().toISOString();

  // ── PHASE 1: PLAN ──────────────────────────────────────────────────────────
  // Build flat entries: { wallet, mint, lamports, symbol, decimals }.
  // Also seed allocation metadata caches for the swap phase.
  const planEntries = [];
  const skipped = [];
  const allocMetaByMint = new Map(); // mint → { symbol, decimals, tokenProgram }

  for (const [walletStr, pref] of customWallets) {
    const stakerRec = stakerByOwner.get(walletStr);
    if (!stakerRec) {
      skipped.push({ wallet: walletStr, reason: 'no_open_position' });
      continue;
    }
    const ownerSlice = effectiveShareLamports(
      distributableLamports, stakerRec.effective, snapshot.totalEffective,
    );
    if (ownerSlice < MIN_PERSONAL_SLICE_LAMPORTS) {
      skipped.push({ wallet: walletStr, reason: 'slice_below_min', sliceLamports: ownerSlice });
      continue;
    }

    const allocs = pref.allocations.map((a) => ({ ...a }));
    let allocated = 0;
    for (let i = 0; i < allocs.length; i += 1) {
      const isLast = i === allocs.length - 1;
      const lamports = isLast
        ? ownerSlice - allocated
        : Math.floor((ownerSlice * allocs[i].pct) / 100);
      allocs[i].lamports = lamports;
      allocated += lamports;
    }

    const subFloor = Math.max(1, Math.floor(MIN_PERSONAL_SLICE_LAMPORTS / 2));
    for (const a of allocs) {
      if (a.lamports < subFloor) {
        skipped.push({
          wallet: walletStr,
          mint: a.mint,
          reason: 'sub_slice_too_small',
          lamports: a.lamports,
        });
        continue;
      }
      planEntries.push({
        wallet: walletStr,
        mint: a.mint,
        lamports: a.lamports,
        symbol: a.symbol || null,
        decimals: a.decimals != null ? a.decimals : null,
      });
      if (a.mint !== SOL_MINT && !allocMetaByMint.has(a.mint)) {
        allocMetaByMint.set(a.mint, {
          symbol: a.symbol || null,
          decimals: a.decimals != null ? a.decimals : null,
        });
      }
    }
  }

  if (planEntries.length === 0) {
    return {
      personalizedLamports: 0,
      residualLamports: distributableLamports,
      payouts: [],
      skipped,
      swaps: [],
      solFallbacks: [],
      cycleStartedAt,
    };
  }

  // ── Group by mint and run pre-spend revalidation per unique mint. ─────────
  const byMint = new Map(); // mint → array of plan entries
  for (const e of planEntries) {
    if (!byMint.has(e.mint)) byMint.set(e.mint, []);
    byMint.get(e.mint).push(e);
  }

  if (REVALIDATE_BEFORE_SPEND) {
    for (const [mint, entries] of byMint) {
      if (mint === SOL_MINT) continue;
      try {
        const v = await validateRewardMint(mint);
        const meta = allocMetaByMint.get(mint) || {};
        if (v?.decimals != null && meta.decimals == null) meta.decimals = v.decimals;
        if (v?.symbol && !meta.symbol) meta.symbol = v.symbol;
        allocMetaByMint.set(mint, meta);
      } catch (e) {
        // Auto-revert every wallet that selected this mint; re-route their
        // share to SOL fallback so they still get paid this cycle.
        for (const entry of entries) {
          markAllocationFailure(entry.wallet, mint, e.code || e.message);
          skipped.push({
            wallet: entry.wallet,
            mint,
            reason: 'revalidation_failed_fallback_to_sol',
            error: e.code || e.message,
            lamports: entry.lamports,
          });
          // Push the same lamports into the SOL bucket so the user gets
          // paid in SOL instead of being silently dropped.
          if (!byMint.has(SOL_MINT)) byMint.set(SOL_MINT, []);
          byMint.get(SOL_MINT).push({
            wallet: entry.wallet,
            mint: SOL_MINT,
            lamports: entry.lamports,
            symbol: 'SOL',
            decimals: 9,
            fallbackFromMint: mint,
          });
        }
        byMint.delete(mint);
      }
    }
  }

  // Resolve token program per remaining SPL mint up-front so swap+transfer
  // both have it.
  for (const mint of [...byMint.keys()]) {
    if (mint === SOL_MINT) continue;
    try {
      const prog = await detectTokenProgram(new PublicKey(mint));
      const meta = allocMetaByMint.get(mint) || {};
      meta.tokenProgram = prog;
      allocMetaByMint.set(mint, meta);
    } catch (e) {
      const entries = byMint.get(mint) || [];
      for (const entry of entries) {
        markAllocationFailure(entry.wallet, mint, e.message);
        skipped.push({
          wallet: entry.wallet,
          mint,
          reason: 'token_program_lookup_failed_fallback_to_sol',
          error: e.message,
          lamports: entry.lamports,
        });
        if (!byMint.has(SOL_MINT)) byMint.set(SOL_MINT, []);
        byMint.get(SOL_MINT).push({
          wallet: entry.wallet,
          mint: SOL_MINT,
          lamports: entry.lamports,
          symbol: 'SOL',
          decimals: 9,
          fallbackFromMint: mint,
        });
      }
      byMint.delete(mint);
    }
  }

  // Dry-run short-circuit: produce a plan-only report and skip all signing.
  if (dryRun) {
    const dryPayouts = [];
    let dryPersonalized = 0;
    for (const [mint, entries] of byMint) {
      for (const e of entries) {
        dryPayouts.push({
          cycleStartedAt,
          wallet: e.wallet,
          mint,
          symbol: e.symbol || allocMetaByMint.get(mint)?.symbol || null,
          decimals: e.decimals ?? allocMetaByMint.get(mint)?.decimals ?? null,
          lamportsSpent: e.lamports,
          dryRun: true,
        });
        dryPersonalized += e.lamports;
      }
    }
    return {
      personalizedLamports: dryPersonalized,
      residualLamports: Math.max(0, distributableLamports - dryPersonalized),
      payouts: dryPayouts,
      skipped,
      swaps: [],
      solFallbacks: [],
      cycleStartedAt,
    };
  }

  // ── PHASE 2: SWAP (aggregated per mint) ───────────────────────────────────
  const swapResults = []; // { mint, totalLamports, swappedRaw, decimals, ok, error }
  const splDistributions = new Map(); // mint → array of { wallet, lamports, amountRaw, decimals }
  const solFallbacks = []; // diagnostic-only: which entries were converted to SOL

  for (const [mint, entries] of byMint) {
    if (mint === SOL_MINT) continue;
    const meta = allocMetaByMint.get(mint) || {};
    const totalLamports = entries.reduce((s, e) => s + e.lamports, 0);
    const treasuryAta = getAssociatedTokenAddressSync(
      new PublicKey(mint),
      treasury.publicKey,
      false,
      meta.tokenProgram,
    );
    const beforeRaw = await readAtaBalanceRaw(treasuryAta);

    let swap;
    try {
      swap = await swapSolToToken({
        devKeypair: treasury,
        outputMint: mint,
        amountLamports: totalLamports,
        slippageBps: SWAP_SLIPPAGE_BPS,
        label: `personal-batch:${(meta.symbol || mint).slice(0, 12)}:${entries.length}w`,
      });
    } catch (e) {
      // Swap failed (typically Jupiter's pool minimum or no route). Convert
      // every wallet for this mint into a SOL-fallback entry so they still
      // get paid, just in SOL rather than the chosen token.
      swapResults.push({
        mint, totalLamports, swappedRaw: 0n, decimals: meta.decimals ?? null,
        ok: false, error: e.message,
        recipients: entries.length,
      });
      logEvent('warn', 'Personalized swap failed — falling back to SOL', {
        mint,
        symbol: meta.symbol,
        recipients: entries.length,
        totalLamports,
        error: e.message,
      });
      for (const entry of entries) {
        solFallbacks.push({
          wallet: entry.wallet,
          fromMint: mint,
          lamports: entry.lamports,
          reason: 'swap_failed',
        });
        if (!byMint.has(SOL_MINT)) byMint.set(SOL_MINT, []);
        byMint.get(SOL_MINT).push({
          wallet: entry.wallet,
          mint: SOL_MINT,
          lamports: entry.lamports,
          symbol: 'SOL',
          decimals: 9,
          fallbackFromMint: mint,
          fallbackReason: 'swap_failed',
        });
      }
      continue;
    }

    const afterRaw = await readAtaBalanceRaw(treasuryAta);
    const swappedRaw = afterRaw > beforeRaw ? afterRaw - beforeRaw : 0n;
    const decimals = meta.decimals ?? swap?.decimals ?? 9;
    if (swappedRaw === 0n) {
      // Treat as a swap failure and fall back to SOL.
      swapResults.push({
        mint, totalLamports, swappedRaw: 0n, decimals,
        ok: false, error: 'swap_produced_zero',
        recipients: entries.length,
      });
      for (const entry of entries) {
        solFallbacks.push({
          wallet: entry.wallet,
          fromMint: mint,
          lamports: entry.lamports,
          reason: 'swap_produced_zero',
        });
        if (!byMint.has(SOL_MINT)) byMint.set(SOL_MINT, []);
        byMint.get(SOL_MINT).push({
          wallet: entry.wallet,
          mint: SOL_MINT,
          lamports: entry.lamports,
          symbol: 'SOL',
          decimals: 9,
          fallbackFromMint: mint,
          fallbackReason: 'swap_produced_zero',
        });
      }
      continue;
    }

    swapResults.push({
      mint, totalLamports, swappedRaw, decimals,
      ok: true, recipients: entries.length,
    });

    // Pro-rata: distribute swappedRaw across recipients by lamport contribution.
    let allocatedRaw = 0n;
    const distribution = entries.map((e, i) => {
      const isLast = i === entries.length - 1;
      const share = isLast
        ? swappedRaw - allocatedRaw
        : (swappedRaw * BigInt(e.lamports)) / BigInt(totalLamports);
      allocatedRaw += isLast ? 0n : share;
      return {
        wallet: e.wallet,
        lamports: e.lamports,
        amountRaw: share,
        decimals,
      };
    });
    splDistributions.set(mint, distribution);
  }

  // Re-collect SOL entries (now includes any swap-fallbacks pushed above).
  const solEntries = byMint.get(SOL_MINT) || [];

  // ── PHASE 3: BATCH TRANSFER ───────────────────────────────────────────────
  const payouts = [];
  let personalizedLamports = 0;

  // 3a) SOL transfers — one System.transfer per recipient, packed by tx size.
  if (solEntries.length > 0) {
    const groups = solEntries
      .filter((e) => e.lamports > 0)
      .map((e) => ({
        ref: e,
        ixs: [SystemProgram.transfer({
          fromPubkey: treasury.publicKey,
          toPubkey: new PublicKey(e.wallet),
          lamports: e.lamports,
        })],
      }));
    const packed = await packIntoTxs(groups, treasury);
    for (const { tx, groupRefs } of packed) {
      let sig;
      try {
        sig = await sendBatch({ tx, treasury });
      } catch (e) {
        for (const g of groupRefs) {
          skipped.push({
            wallet: g.ref.wallet,
            mint: SOL_MINT,
            reason: 'sol_batch_failed',
            error: e.message,
            lamports: g.ref.lamports,
          });
        }
        continue;
      }
      const postedAt = new Date().toISOString();
      const rows = groupRefs.map(({ ref }) => ({
        cycleStartedAt,
        wallet: ref.wallet,
        mint: SOL_MINT,
        symbol: 'SOL',
        decimals: 9,
        lamportsSpent: ref.lamports,
        lamports: ref.lamports,
        signature: sig,
        postedAt,
        fallbackFromMint: ref.fallbackFromMint || undefined,
        fallbackReason: ref.fallbackReason || undefined,
      }));
      appendLedger(rows);
      payouts.push(...rows);
      personalizedLamports += rows.reduce((s, r) => s + r.lamports, 0);
    }
  }

  // 3b) SPL transfers — per mint, one ATA-create-idempotent + transferChecked
  // per recipient, greedy-packed.
  for (const [mint, distribution] of splDistributions) {
    const meta = allocMetaByMint.get(mint) || {};
    const tokenProgram = meta.tokenProgram;
    if (!tokenProgram) continue;
    const mintPk = new PublicKey(mint);
    const treasuryAta = getAssociatedTokenAddressSync(mintPk, treasury.publicKey, false, tokenProgram);
    const groups = distribution
      .filter((d) => d.amountRaw > 0n)
      .map((d) => {
        const recipientPk = new PublicKey(d.wallet);
        const recipientAta = getAssociatedTokenAddressSync(mintPk, recipientPk, false, tokenProgram);
        return {
          ref: { ...d, mint, recipientAta: recipientAta.toBase58() },
          ixs: [
            createAssociatedTokenAccountIdempotentInstruction(
              treasury.publicKey,
              recipientAta,
              recipientPk,
              mintPk,
              tokenProgram,
            ),
            createTransferCheckedInstruction(
              treasuryAta,
              mintPk,
              recipientAta,
              treasury.publicKey,
              d.amountRaw,
              d.decimals,
              [],
              tokenProgram,
            ),
          ],
        };
      });
    if (groups.length === 0) continue;
    const packed = await packIntoTxs(groups, treasury);
    for (const { tx, groupRefs } of packed) {
      let sig;
      try {
        sig = await sendBatch({ tx, treasury });
      } catch (e) {
        for (const g of groupRefs) {
          skipped.push({
            wallet: g.ref.wallet,
            mint: g.ref.mint,
            reason: 'spl_batch_failed',
            error: e.message,
            lamports: g.ref.lamports,
          });
        }
        continue;
      }
      const postedAt = new Date().toISOString();
      const rows = groupRefs.map(({ ref }) => ({
        cycleStartedAt,
        wallet: ref.wallet,
        mint: ref.mint,
        symbol: meta.symbol || null,
        decimals: ref.decimals,
        lamportsSpent: ref.lamports,
        tokenAmountRaw: ref.amountRaw.toString(),
        tokenAmountUi: Number(ref.amountRaw) / Math.pow(10, ref.decimals),
        signature: sig,
        postedAt,
      }));
      appendLedger(rows);
      payouts.push(...rows);
      personalizedLamports += rows.reduce((s, r) => s + r.lamportsSpent, 0);
    }
  }

  const residualLamports = Math.max(0, distributableLamports - personalizedLamports);

  logEvent('info', 'Personalized spend complete', {
    personalizedSol: personalizedLamports / 1e9,
    residualSol: residualLamports / 1e9,
    swaps: swapResults.length,
    swapsOk: swapResults.filter((s) => s.ok).length,
    payouts: payouts.length,
    solFallbacks: solFallbacks.length,
    skipped: skipped.length,
  });

  return {
    personalizedLamports,
    residualLamports,
    payouts,
    skipped,
    swaps: swapResults.map((s) => ({
      mint: s.mint,
      totalLamports: s.totalLamports,
      swappedRaw: s.swappedRaw?.toString?.() || '0',
      decimals: s.decimals,
      ok: s.ok,
      recipients: s.recipients,
      error: s.error || undefined,
    })),
    solFallbacks,
    cycleStartedAt,
  };
}

function emptyResult(residualLamports) {
  return {
    personalizedLamports: 0,
    residualLamports,
    payouts: [],
    skipped: [],
    swaps: [],
    solFallbacks: [],
  };
}

function readPayoutLedger({ wallet = null, limit = 200 } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(PAYOUT_LEDGER, 'utf8');
  } catch (_) {
    return [];
  }
  const rows = raw.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
  const filtered = wallet ? rows.filter((r) => r.wallet === wallet) : rows;
  return filtered.slice(-limit).reverse();
}

module.exports = {
  PAYOUT_LEDGER,
  runPersonalizedSpend,
  readPayoutLedger,
  snapshotStakers,
  effectiveShareLamports,
};
