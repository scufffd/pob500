'use strict';

/**
 * Auto-push accrued staking rewards to each position owner's wallet using the
 * on-chain `claim_push` instruction (pool authority signs). Optional worker
 * phase — enable with `POB_STAKE_AUTO_PUSH_CLAIMS=1`.
 */

const path = require('path');
const fs = require('fs');
const {
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  getMint,
  getTransferFeeConfig,
} = require('@solana/spl-token');

const BN = require('bn.js');
const config = require('./config');
const { logEvent } = require('./utils');
const { resolveStakingConfig } = require('./stake-distribute');

const SDK_IDL_PATH = path.join(__dirname, '..', '..', 'staking-sdk', 'src', 'idl.json');
const TX_PACKET_BUDGET = 1180;

// Padding lamports to top up newly-created Token-2022 ATAs so Token-2022 can
// grow them in-place when a transfer-fee TransferChecked arrives. Creation via
// the associated-token-program allocates only the basic 165-byte rent
// (~1,501,879 lamports); the TransferFeeAmount extension bumps required rent
// to ~1,733,040. 500_000 lamports gives headroom for a couple of extensions
// without being wasteful.
const TOKEN_2022_ATA_RENT_PADDING_LAMPORTS = parseInt(
  process.env.POB_STAKE_PUSH_T22_PADDING_LAMPORTS || '500000',
  10,
);

function loadIdl(programId) {
  const idl = JSON.parse(fs.readFileSync(SDK_IDL_PATH, 'utf8'));
  return { ...idl, address: programId.toBase58() };
}

async function detectTokenProgram(connection, mint) {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`Mint ${mint.toBase58()} not found`);
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  throw new Error(`Mint ${mint.toBase58()} is not SPL / Token-2022`);
}

async function mintHasTransferFee(connection, mint, tokenProgram) {
  if (!tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) return false;
  try {
    const m = await getMint(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
    return !!getTransferFeeConfig(m);
  } catch {
    return false;
  }
}

function findCheckpointPda(programId, position, rewardMintPda) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('checkpoint'), position.toBuffer(), rewardMintPda.toBuffer()],
    programId,
  )[0];
}

function rewardVaultAta(pool, mint, tokenProgram) {
  return getAssociatedTokenAddressSync(mint, pool, true, tokenProgram);
}

/** Same math as staking-sdk `computePending`. */
function computePending({ accPerShare, effective, checkpointAcc, claimable }) {
  const ACC = new BN('1000000000000000000');
  const delta = new BN(String(accPerShare)).sub(new BN(String(checkpointAcc || 0)));
  const accrued = delta.mul(new BN(String(effective))).div(ACC);
  return new BN(String(claimable || 0)).add(accrued);
}

function packIxs(ixGroups, feePayer, recentBlockhash, priorityFeeIx) {
  // `ixGroups` is an array of arrays. Each inner array is an atomic group of
  // ixs that MUST land together in the same tx (e.g. [createAtaIdempotent,
  // claimPush]). Splitting a group across txs would land claim_push without
  // its preceding ATA-create, triggering AccountNotInitialized (0xbc4).
  const txs = [];
  const baseOverhead = priorityFeeIx ? 1 : 0;
  let current = new Transaction();
  current.feePayer = feePayer;
  current.recentBlockhash = recentBlockhash;
  if (priorityFeeIx) current.add(priorityFeeIx);

  const trySerialize = (tx) => {
    try {
      return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
    } catch {
      return Infinity;
    }
  };

  for (const group of ixGroups) {
    for (const ix of group) current.add(ix);
    const size = trySerialize(current);
    if (size > TX_PACKET_BUDGET) {
      for (let i = 0; i < group.length; i++) current.instructions.pop();
      if (current.instructions.length === baseOverhead) {
        throw new Error(`Single group (${group.length} ixs) exceeds tx packet budget (size=${size})`);
      }
      txs.push(current);
      current = new Transaction();
      current.feePayer = feePayer;
      current.recentBlockhash = recentBlockhash;
      if (priorityFeeIx) current.add(priorityFeeIx);
      for (const ix of group) current.add(ix);
    }
  }
  if (current.instructions.length > baseOverhead) txs.push(current);
  return txs;
}

/**
 * @param {object} opts
 * @param {import('@solana/web3.js').Keypair} opts.treasury    Fee payer + ATA rent payer (Bank)
 * @param {import('@solana/web3.js').Keypair} [opts.authority] Pool authority signer (defaults to treasury)
 * @param {boolean} [opts.primeOnly] Only create missing checkpoints, then return
 * @returns {Promise<object>}
 */
async function pushRewardClaims({ treasury, authority, primeOnly = false }) {
  const cfg = resolveStakingConfig();
  if (!cfg.configured || !cfg.programId || !cfg.stakeMint) {
    return { skipped: 'staking_not_configured' };
  }

  const auth = authority || treasury;
  const samePayerAndAuth = auth.publicKey.equals(treasury.publicKey);

  const minRaw = BigInt(process.env.POB_STAKE_PUSH_MIN_RAW || '1');
  const maxTx = Math.max(1, parseInt(process.env.POB_STAKE_PUSH_MAX_TX || '25', 10));

  const connection = config.stakeConnection;
  const anchor = require('@coral-xyz/anchor');
  const wallet = {
    publicKey: treasury.publicKey,
    signTransaction: async (tx) => {
      tx.partialSign(treasury);
      return tx;
    },
    signAllTransactions: async (txs) => txs.map((tx) => {
      tx.partialSign(treasury);
      return tx;
    }),
  };
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
  const program = new anchor.Program(loadIdl(cfg.programId), provider);

  const pool = await program.account.stakePool.fetch(cfg.pool);
  if (!pool.authority.equals(auth.publicKey)) {
    logEvent('warn', 'stake-push: authority keypair is not pool authority — skipping', {
      authority: auth.publicKey.toBase58(),
      expected: pool.authority.toBase58(),
    });
    return { skipped: 'not_pool_authority' };
  }

  const positions = await program.account.stakePosition.all([
    { memcmp: { offset: 9, bytes: cfg.pool.toBase58() } },
  ]);
  const active = positions
    .map((a) => ({ publicKey: a.publicKey, account: a.account }))
    .filter((p) => !p.account.closed);

  const rewardMints = await program.account.rewardMint.all([
    { memcmp: { offset: 8 + 1, bytes: cfg.pool.toBase58() } },
  ]);

  // Per-mint metadata: token program + whether the mint has a transfer-fee
  // extension (which forces the destination ATA to grow from ~165 → ~185 bytes
  // on first receive, requiring rent pre-funding).
  const mintMeta = new Map();
  for (const rm of rewardMints) {
    const m = rm.account.mint;
    const key = m.toBase58();
    const tokenProgram = await detectTokenProgram(connection, m);
    const hasFee = await mintHasTransferFee(connection, m, tokenProgram);
    mintMeta.set(key, { tokenProgram, hasTransferFee: hasFee });
  }

  const work = [];
  const toPrime = [];
  for (const pos of active) {
    const owner = pos.account.owner;
    for (const rm of rewardMints) {
      const rewardMintPk = rm.account.mint;
      const meta = mintMeta.get(rewardMintPk.toBase58());
      const tokenProgram = meta.tokenProgram;
      const userAta = getAssociatedTokenAddressSync(rewardMintPk, owner, false, tokenProgram);
      const ckPk = findCheckpointPda(cfg.programId, pos.publicKey, rm.publicKey);
      let ck = null;
      try {
        ck = await program.account.rewardCheckpoint.fetchNullable(ckPk);
      } catch {
        ck = null;
      }
      // Missing checkpoint: stake joined after this mint was registered. The
      // on-chain `claim_push` would init_if_needed it (paid by authority) but
      // the resulting payout would be 0 (baseline-safe). Instead we prime it
      // separately below, using the treasury as payer, and skip claim_push
      // for this position/mint this cycle — it'll accrue from next deposit.
      if (!ck) {
        toPrime.push({
          position: pos.publicKey,
          rewardMintPda: rm.publicKey,
          checkpoint: ckPk,
        });
        continue;
      }
      const pending = computePending({
        accPerShare: rm.account.accPerShare,
        effective: pos.account.effective,
        checkpointAcc: ck.accPerShare || 0,
        claimable: ck.claimable || 0,
      });
      if (pending.isZero() || BigInt(pending.toString()) < minRaw) continue;
      work.push({
        position: pos.publicKey,
        owner,
        rewardMintPda: rm.publicKey,
        rewardTokenMint: rewardMintPk,
        tokenProgram,
        hasTransferFee: meta.hasTransferFee,
        userAta,
        pendingRaw: pending.toString(),
      });
    }
  }

  // Phase 1: prime any missing checkpoints, paid by treasury (Bank), NOT the
  // pool authority. This is permissionless and cheap — just creates the PDA
  // with a baseline acc_per_share snapshot.
  let primedCount = 0;
  if (toPrime.length > 0) {
    const primeIxs = [];
    for (const p of toPrime) {
      primeIxs.push(
        await program.methods
          .primeCheckpoint()
          .accounts({
            pool: cfg.pool,
            rewardMint: p.rewardMintPda,
            position: p.position,
            checkpoint: p.checkpoint,
            payer: treasury.publicKey,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .instruction(),
      );
    }
    const priorityMicros = Math.max(1, Math.round((config.ONE_TIME_PRIORITY_FEE || 0.000001) * 1e9 * 1000));
    const primeCuIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicros });
    const { blockhash: bh1, lastValidBlockHeight: lvh1 } =
      await connection.getLatestBlockhash('confirmed');
    const primeGroups = primeIxs.map((ix) => [ix]);
    const primeTxs = packIxs(primeGroups, treasury.publicKey, bh1, primeCuIx);
    for (const tx of primeTxs) {
      tx.lastValidBlockHeight = lvh1;
      try {
        await sendAndConfirmTransaction(connection, tx, [treasury], {
          commitment: 'confirmed',
          skipPreflight: false,
        });
        primedCount += tx.instructions.length - 1;
      } catch (e) {
        logEvent('warn', 'stake-push: prime_checkpoint batch failed', { error: e.message });
      }
    }
    logEvent('info', 'stake-push: primed missing checkpoints', {
      attempted: toPrime.length,
      primed: primedCount,
    });
  }

  if (primeOnly) {
    return {
      skipped: 'prime_only',
      positions: active.length,
      rewardLines: rewardMints.length,
      primedCheckpoints: primedCount,
      pendingPrime: toPrime.length - primedCount,
    };
  }

  if (work.length === 0) {
    return {
      skipped: 'nothing_to_push',
      positions: active.length,
      rewardLines: rewardMints.length,
      primedCheckpoints: primedCount,
      pendingPrime: toPrime.length - primedCount,
    };
  }

  // Build ixs in atomic groups: each group = [createAtaIdempotent, (optional
  // rent padding), claimPush] so packIxs can never split a claim_push away
  // from its ATA-create. The padding ensures Token-2022 can grow the ATA
  // in-place if the reward mint has TransferFeeConfig.
  const ixGroups = [];
  for (const w of work) {
    const group = [];
    group.push(
      createAssociatedTokenAccountIdempotentInstruction(
        treasury.publicKey,
        w.userAta,
        w.owner,
        w.rewardTokenMint,
        w.tokenProgram,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
    // Pad the destination ATA only if the reward mint has a TransferFeeConfig
    // extension — that's the one case where Token-2022 grows the ATA mid-
    // transfer and charges the difference against the account's own balance.
    if (w.hasTransferFee && TOKEN_2022_ATA_RENT_PADDING_LAMPORTS > 0) {
      group.push(
        SystemProgram.transfer({
          fromPubkey: treasury.publicKey,
          toPubkey: w.userAta,
          lamports: TOKEN_2022_ATA_RENT_PADDING_LAMPORTS,
        }),
      );
    }
    const vault = rewardVaultAta(cfg.pool, w.rewardTokenMint, w.tokenProgram);
    const checkpoint = findCheckpointPda(cfg.programId, w.position, w.rewardMintPda);
    group.push(
      await program.methods
        .claimPush()
        .accounts({
          pool: cfg.pool,
          authority: auth.publicKey,
          rewardMint: w.rewardMintPda,
          mint: w.rewardTokenMint,
          vault,
          position: w.position,
          checkpoint,
          userTokenAccount: w.userAta,
          tokenProgram: w.tokenProgram,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .instruction(),
    );
    ixGroups.push(group);
  }

  const priorityFeeMicroLamports = Math.max(
    1,
    Math.round((config.ONE_TIME_PRIORITY_FEE || 0.000001) * 1e9 * 1000),
  );
  const priorityIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports });

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const txs = packIxs(ixGroups, treasury.publicKey, blockhash, priorityIx);
  const toSend = txs.slice(0, maxTx);
  const signatures = [];

  const signers = samePayerAndAuth ? [treasury] : [treasury, auth];
  for (let i = 0; i < toSend.length; i++) {
    const tx = toSend[i];
    tx.lastValidBlockHeight = lastValidBlockHeight;
    const sig = await sendAndConfirmTransaction(connection, tx, signers, {
      commitment: 'confirmed',
      skipPreflight: false,
    });
    signatures.push(sig);
  }

  const out = {
    workQueued: work.length,
    txsPacked: txs.length,
    txsSent: toSend.length,
    txsTruncated: Math.max(0, txs.length - toSend.length),
    primedCheckpoints: primedCount,
    signatures,
    positionsScanned: active.length,
  };
  logEvent('info', 'stake-push: reward claims pushed', out);
  return out;
}

module.exports = { pushRewardClaims };
