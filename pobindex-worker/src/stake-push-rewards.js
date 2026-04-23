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
} = require('@solana/spl-token');

const BN = require('bn.js');
const config = require('./config');
const { logEvent } = require('./utils');
const { resolveStakingConfig } = require('./stake-distribute');

const SDK_IDL_PATH = path.join(__dirname, '..', '..', 'staking-sdk', 'src', 'idl.json');
const TX_PACKET_BUDGET = 1180;

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

function packIxs(ixs, feePayer, recentBlockhash, priorityFeeIx) {
  const txs = [];
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

  for (const ix of ixs) {
    current.add(ix);
    const size = trySerialize(current);
    if (size > TX_PACKET_BUDGET) {
      current.instructions.pop();
      if (current.instructions.length === (priorityFeeIx ? 1 : 0)) {
        throw new Error(`Single instruction exceeds tx packet budget (size=${size})`);
      }
      txs.push(current);
      current = new Transaction();
      current.feePayer = feePayer;
      current.recentBlockhash = recentBlockhash;
      if (priorityFeeIx) current.add(priorityFeeIx);
      current.add(ix);
    }
  }
  if (current.instructions.length > (priorityFeeIx ? 1 : 0)) txs.push(current);
  return txs;
}

/**
 * @param {object} opts
 * @param {import('@solana/web3.js').Keypair} opts.treasury  Must be `pool.authority`
 * @returns {Promise<object>}
 */
async function pushRewardClaims({ treasury }) {
  const cfg = resolveStakingConfig();
  if (!cfg.configured || !cfg.programId || !cfg.stakeMint) {
    return { skipped: 'staking_not_configured' };
  }

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
  if (!pool.authority.equals(treasury.publicKey)) {
    logEvent('warn', 'stake-push: treasury is not pool authority — skipping', {
      treasury: treasury.publicKey.toBase58(),
      authority: pool.authority.toBase58(),
    });
    return { skipped: 'treasury_not_pool_authority' };
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

  const work = [];
  for (const pos of active) {
    const owner = pos.account.owner;
    for (const rm of rewardMints) {
      const rewardMintPk = rm.account.mint;
      const tokenProgram = await detectTokenProgram(connection, rewardMintPk);
      const userAta = getAssociatedTokenAddressSync(rewardMintPk, owner, false, tokenProgram);
      const ckPk = findCheckpointPda(cfg.programId, pos.publicKey, rm.publicKey);
      let ck = null;
      try {
        ck = await program.account.rewardCheckpoint.fetchNullable(ckPk);
      } catch {
        ck = null;
      }
      const pending = computePending({
        accPerShare: rm.account.accPerShare,
        effective: pos.account.effective,
        checkpointAcc: ck?.accPerShare || 0,
        claimable: ck?.claimable || 0,
      });
      if (pending.isZero() || BigInt(pending.toString()) < minRaw) continue;
      work.push({
        position: pos.publicKey,
        owner,
        rewardMintPda: rm.publicKey,
        rewardTokenMint: rewardMintPk,
        tokenProgram,
        userAta,
        pendingRaw: pending.toString(),
      });
    }
  }

  if (work.length === 0) {
    return { skipped: 'nothing_to_push', positions: active.length, rewardLines: rewardMints.length };
  }

  const ixs = [];
  for (const w of work) {
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        treasury.publicKey,
        w.userAta,
        w.owner,
        w.rewardTokenMint,
        w.tokenProgram,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
    const vault = rewardVaultAta(cfg.pool, w.rewardTokenMint, w.tokenProgram);
    const checkpoint = findCheckpointPda(cfg.programId, w.position, w.rewardMintPda);
    ixs.push(
      await program.methods
        .claimPush()
        .accounts({
          pool: cfg.pool,
          authority: treasury.publicKey,
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
  }

  const priorityFeeMicroLamports = Math.max(
    1,
    Math.round((config.ONE_TIME_PRIORITY_FEE || 0.000001) * 1e9 * 1000),
  );
  const priorityIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports });

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const txs = packIxs(ixs, treasury.publicKey, blockhash, priorityIx);
  const toSend = txs.slice(0, maxTx);
  const signatures = [];

  for (let i = 0; i < toSend.length; i++) {
    const tx = toSend[i];
    tx.lastValidBlockHeight = lastValidBlockHeight;
    const sig = await sendAndConfirmTransaction(connection, tx, [treasury], {
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
    signatures,
    positionsScanned: active.length,
  };
  logEvent('info', 'stake-push: reward claims pushed', out);
  return out;
}

module.exports = { pushRewardClaims };
