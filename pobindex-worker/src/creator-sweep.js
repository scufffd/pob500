'use strict';

/**
 * creator-sweep.js — moves creator-fee payouts (received from Printr) off of
 * per-token creator wallets into the worker treasury, so the existing
 * `runCycle → swap → deposit_rewards` pipeline can act on them.
 *
 * Today Printr batches creator-fee claims on Meteora DBC with their own keeper
 * (signer = Printr PDA "82VbB…", on-chain creator), then their distribution
 * program routes the payout SOL to each creator's wallet (e.g. DMw5A for our
 * GfnK…brrr token). The Printr team has confirmed an API endpoint will ship
 * that returns calldata to trigger that claim from any payer. Until then, the
 * sweeper just forwards whatever Printr has already deposited.
 *
 * Config is driven by the CREATOR_WALLETS env var, a JSON array of either:
 *   - base58 secret keys (Phantom/Solflare export format), or
 *   - objects with { label, secretKey, minLamports?, bufferLamports? }
 *
 * Simpler single-wallet form also supported via CREATOR_WALLET_PRIVATE_KEY.
 */

const {
  PublicKey,
  SystemProgram,
  Transaction,
  ComputeBudgetProgram,
  TransactionInstruction,
  Keypair,
} = require('@solana/web3.js');
const bs58 = require('bs58');

const config = require('./config');
const { logEvent, formatSol } = require('./utils');

// Programs that are safe to replay verbatim in a Printr claim template. Any ix
// whose program isn't on this list is dropped — this keeps aggregator/tip
// instructions (e.g. L2TEx…) that sometimes appear in the source tx from
// breaking future replays.
const PRINTR_CLAIM_REPLAY_PROGRAMS = new Set([
  'ComputeBudget111111111111111111111111111111',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',  // Associated Token
  'T8HsGYv7sMk3kTnyaRqZrbRPuntYzdh12evXBkprint',   // Printr
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',   // SPL Token legacy
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',   // Token-2022
  '11111111111111111111111111111111',              // System
]);

const DEFAULT_SWEEP_MIN_LAMPORTS = Math.round(
  parseFloat(process.env.SWEEP_MIN_LAMPORTS_SOL || '0.05') * 1e9,
);
const DEFAULT_SWEEP_BUFFER_LAMPORTS = Math.round(
  parseFloat(process.env.SWEEP_BUFFER_LAMPORTS_SOL || '0.01') * 1e9,
);

function parseConfiguredWallets() {
  const wallets = [];

  const raw = (process.env.CREATOR_WALLETS || '').trim();
  if (raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`CREATOR_WALLETS must be valid JSON: ${e.message}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error('CREATOR_WALLETS must be a JSON array');
    }
    for (const [i, entry] of parsed.entries()) {
      if (typeof entry === 'string') {
        wallets.push({ label: `creator#${i}`, secretKey: entry });
      } else if (entry && typeof entry === 'object' && entry.secretKey) {
        wallets.push({
          label: entry.label || `creator#${i}`,
          secretKey: entry.secretKey,
          minLamports: entry.minLamports,
          bufferLamports: entry.bufferLamports,
        });
      } else {
        throw new Error(`CREATOR_WALLETS[${i}] invalid — need string or object with secretKey`);
      }
    }
  }

  const singleKey = (process.env.CREATOR_WALLET_PRIVATE_KEY || '').trim();
  if (singleKey) {
    wallets.push({ label: 'creator', secretKey: singleKey });
  }

  return wallets;
}

/**
 * Sweep ready-to-move SOL from all configured creator wallets into the
 * worker treasury. Safe to call on every cycle — no-ops when balances are
 * below threshold.
 *
 * @param {import('@solana/web3.js').PublicKey} treasuryPubkey
 * @returns {Promise<{swept: Array, skipped: Array, totalLamports: number}>}
 */
async function sweepCreatorWallets(treasuryPubkey) {
  const wallets = parseConfiguredWallets();
  const connection = config.connection;
  const swept = [];
  const skipped = [];
  let totalLamports = 0;

  if (wallets.length === 0) {
    return { swept, skipped, totalLamports };
  }

  for (const w of wallets) {
    let kp;
    try {
      kp = config.parsePrivateKey(w.secretKey);
    } catch (e) {
      skipped.push({ label: w.label, reason: `invalid key: ${e.message}` });
      continue;
    }
    const min = w.minLamports ?? DEFAULT_SWEEP_MIN_LAMPORTS;
    const buffer = w.bufferLamports ?? DEFAULT_SWEEP_BUFFER_LAMPORTS;

    try {
      const bal = await connection.getBalance(kp.publicKey, 'confirmed');
      if (bal < min) {
        skipped.push({
          label: w.label,
          wallet: kp.publicKey.toBase58(),
          balanceLamports: bal,
          reason: `below_min (${formatSol(bal)} < ${formatSol(min)})`,
        });
        continue;
      }

      const sendLamports = bal - buffer;
      if (sendLamports <= 0) {
        skipped.push({
          label: w.label,
          wallet: kp.publicKey.toBase58(),
          balanceLamports: bal,
          reason: `buffer_eats_balance (buf=${formatSol(buffer)})`,
        });
        continue;
      }

      const tx = new Transaction();
      if (config.ONE_TIME_PRIORITY_FEE) {
        tx.add(
          ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: Math.max(1, Math.round(config.ONE_TIME_PRIORITY_FEE * 1e6)),
          }),
        );
      }
      tx.add(
        SystemProgram.transfer({
          fromPubkey: kp.publicKey,
          toPubkey: treasuryPubkey,
          lamports: sendLamports,
        }),
      );

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.feePayer = kp.publicKey;
      tx.sign(kp);

      const sig = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');

      totalLamports += sendLamports;
      swept.push({
        label: w.label,
        wallet: kp.publicKey.toBase58(),
        lamports: sendLamports,
        sol: sendLamports / 1e9,
        signature: sig,
      });
      logEvent('info', '[CreatorSweep] swept', {
        wallet: kp.publicKey.toBase58(),
        amount: formatSol(sendLamports),
        sig,
      });
    } catch (e) {
      skipped.push({
        label: w.label,
        wallet: kp.publicKey.toBase58(),
        reason: e.message || String(e),
      });
      logEvent('warn', '[CreatorSweep] failed', {
        wallet: kp.publicKey.toBase58(),
        error: e.message,
      });
    }
  }

  return { swept, skipped, totalLamports };
}

/**
 * Placeholder for Printr-provided creator-fee claim calldata.
 *
 * Once Printr's API lands, this will:
 *   1. POST { tokenMint, payer } to their endpoint and receive base64 ix data.
 *   2. Build a VersionedTransaction, sign with the payer, and submit.
 *   3. After confirm, Printr's distribution program moves the freed SOL to the
 *      creator wallet — which `sweepCreatorWallets` then picks up on the next
 *      cycle (or we can await confirm + sweep inline).
 *
 * Returns { attempted, claimed, notes } so callers can log status.
 */
async function printrClaim(/* { tokenMint, payer } */) {
  return {
    attempted: false,
    claimed: 0,
    notes:
      'printrClaim() not implemented — waiting for Printr API. Creator-mode ' +
      'tokens still distribute via Printr keeper, arriving on the creator wallet.',
  };
}

module.exports = {
  sweepCreatorWallets,
  printrClaim,
  DEFAULT_SWEEP_MIN_LAMPORTS,
  DEFAULT_SWEEP_BUFFER_LAMPORTS,
  claimViaPrintrTemplate,
};

function decodeIxData(ix) {
  if (ix.data instanceof Uint8Array) return Buffer.from(ix.data);
  return Buffer.from(bs58.decode(ix.data));
}

function getMessageKeys(tx) {
  const msg = tx.transaction.message;
  const staticKeys = (msg.staticAccountKeys || msg.accountKeys || []).map((k) =>
    k.toBase58 ? k.toBase58() : String(k),
  );
  const writableLoaded = (tx.meta?.loadedAddresses?.writable || []).map((k) =>
    k.toBase58 ? k.toBase58() : String(k),
  );
  const readonlyLoaded = (tx.meta?.loadedAddresses?.readonly || []).map((k) =>
    k.toBase58 ? k.toBase58() : String(k),
  );
  return {
    msg,
    staticKeys,
    writableLoaded,
    readonlyLoaded,
    allKeys: [...staticKeys, ...writableLoaded, ...readonlyLoaded],
  };
}

function keyMetaByIndex(msg, staticLen, idx) {
  const required = msg.header.numRequiredSignatures;
  const roSigned = msg.header.numReadonlySignedAccounts;
  const roUnsigned = msg.header.numReadonlyUnsignedAccounts;
  if (idx < staticLen) {
    const isSigner = idx < required;
    let isWritable;
    if (isSigner) {
      isWritable = idx < (required - roSigned);
    } else {
      const unsignedIdx = idx - required;
      const unsignedLen = staticLen - required;
      isWritable = unsignedIdx < (unsignedLen - roUnsigned);
    }
    return { isSigner, isWritable };
  }
  const loadedStart = staticLen;
  const writableLoadedLen = msg.addressTableLookups
    ? (msg.addressTableLookups.reduce((acc, l) => acc + l.writableIndexes.length, 0))
    : 0;
  const loadedIdx = idx - loadedStart;
  return {
    isSigner: false,
    isWritable: loadedIdx < writableLoadedLen,
  };
}

function rewritePubkey(pk, fromPk, toPk) {
  return pk === fromPk ? toPk : pk;
}

/**
 * Replay a known-good Printr claim tx template using a different fee payer.
 * This is a practical bridge until Printr ships an official calldata endpoint.
 *
 * Required env:
 * - PRINTR_CLAIM_TEMPLATE_SIG: a successful claim signature for YOUR token.
 * - PRINTR_CLAIM_FEEPAYER_PRIVATE_KEY (or falls back to TREASURY_PRIVATE_KEY)
 *
 * Optional:
 * - PRINTR_CLAIM_DRY_RUN=1 (simulate only)
 */
async function claimViaPrintrTemplate() {
  let templateSig = (process.env.PRINTR_CLAIM_TEMPLATE_SIG || '').trim();
  const payerRaw = (process.env.PRINTR_CLAIM_FEEPAYER_PRIVATE_KEY || process.env.TREASURY_PRIVATE_KEY || '').trim();
  if (!payerRaw) {
    return { attempted: false, reason: 'missing PRINTR_CLAIM_FEEPAYER_PRIVATE_KEY / TREASURY_PRIVATE_KEY' };
  }

  const connection = config.connection;
  if (!templateSig) {
    const pool = (process.env.PRINTR_CLAIM_POOL || '').trim();
    if (pool) {
      templateSig = await discoverTemplateSigForPool(connection, pool);
    }
  }
  if (!templateSig) {
    return {
      attempted: false,
      reason: 'missing PRINTR_CLAIM_TEMPLATE_SIG (or no claim found for PRINTR_CLAIM_POOL)',
    };
  }

  const payer = config.parsePrivateKey(payerRaw);

  const tx = await connection.getTransaction(templateSig, {
    maxSupportedTransactionVersion: 0,
    commitment: 'confirmed',
  });
  if (!tx) return { attempted: false, reason: 'template tx not found' };

  const { msg, allKeys, staticKeys } = getMessageKeys(tx);
  if (msg.header.numRequiredSignatures !== 1) {
    return {
      attempted: false,
      reason: `template has ${msg.header.numRequiredSignatures} signers; expected 1`,
    };
  }

  const oldPayer = staticKeys[0];
  const newPayer = payer.publicKey.toBase58();
  const ixs = msg.compiledInstructions || msg.instructions || [];

  const rebuilt = [];
  const skipped = [];
  for (const ix of ixs) {
    const pid = rewritePubkey(allKeys[ix.programIdIndex], oldPayer, newPayer);
    if (!PRINTR_CLAIM_REPLAY_PROGRAMS.has(pid)) {
      skipped.push(pid);
      continue;
    }
    const idxs = ix.accountKeyIndexes || ix.accounts;
    const keys = idxs.map((ai) => {
      const pk = rewritePubkey(allKeys[ai], oldPayer, newPayer);
      const meta = keyMetaByIndex(msg, staticKeys.length, ai);
      return {
        pubkey: new PublicKey(pk),
        isSigner: pk === newPayer ? true : meta.isSigner,
        isWritable: meta.isWritable,
      };
    });
    rebuilt.push(
      new TransactionInstruction({
        programId: new PublicKey(pid),
        keys,
        data: decodeIxData(ix),
      }),
    );
  }

  const out = {
    attempted: true,
    templateSig,
    oldPayer,
    newPayer,
    instructionCount: rebuilt.length,
    skippedPrograms: skipped,
  };

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const sendTx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight }).add(...rebuilt);
  sendTx.sign(payer);

  const sim = await connection.simulateTransaction(sendTx);
  out.simulation = {
    err: sim.value.err || null,
    logs: sim.value.logs || [],
  };
  if (sim.value.err) {
    out.sent = false;
    out.reason = 'simulation_failed';
    out.note =
      'No transaction was sent. Usually means zero claimable creator fees for this template, ' +
      'or the on-chain state no longer matches the template. Safe to retry next cycle.';
    return out;
  }

  if (String(process.env.PRINTR_CLAIM_DRY_RUN || '0') === '1') {
    out.sent = false;
    out.reason = 'dry_run';
    return out;
  }

  const sig = await connection.sendRawTransaction(sendTx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  out.sent = true;
  out.signature = sig;
  return out;
}

async function discoverTemplateSigForPool(connection, poolAddress) {
  const T8_PROGRAM = 'T8HsGYv7sMk3kTnyaRqZrbRPuntYzdh12evXBkprint';
  const CLAIM_DISC = '1fc558ef7ba5c5d0';
  const pool = new PublicKey(poolAddress);
  const sigs = await connection.getSignaturesForAddress(pool, { limit: 150 });
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await connection.getTransaction(s.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
    if (!tx) continue;
    const { msg, allKeys } = getMessageKeys(tx);
    const ixs = msg.compiledInstructions || msg.instructions || [];
    for (const ix of ixs) {
      const pid = allKeys[ix.programIdIndex];
      if (pid !== T8_PROGRAM) continue;
      const data = decodeIxData(ix).toString('hex');
      if (data.startsWith(CLAIM_DISC)) return s.signature;
    }
  }
  return '';
}
