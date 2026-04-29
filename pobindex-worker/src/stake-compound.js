'use strict';

/**
 * stake-compound.js — auto-compound personalized POB500 rewards.
 *
 * When a user opts into compound mode in their reward preference, we skip the
 * `transferChecked` airdrop step for the stake-mint slice and instead call
 * `stake_for(beneficiary=user, amount, lockDays=user.compound.lockDays)`
 * directly from the treasury. The user's wallet is set as `position.owner`,
 * so they retain full custody — treasury cannot claim, move, or unstake.
 *
 * Each compound also primes a fresh checkpoint per registered RewardMint so
 * the new position accrues from the very next deposit_rewards.
 *
 * Batching: all (stake_for + prime_checkpoint × N) ixs for a single user are
 * packed into the smallest set of 1200-byte transactions. We send them
 * sequentially with `sendAndConfirmTransaction` so failures roll back to a
 * SOL fallback path.
 */

const path = require('path');
const fs = require('fs');
const {
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  sendAndConfirmTransaction,
} = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} = require('@solana/spl-token');
const BN = require('bn.js');

const config = require('./config');
const { logEvent } = require('./utils');
const { getAccountInfoCached } = require('./rpc-account-cache');
const { resolveStakingConfig } = require('./stake-distribute');

const TX_PACKET_BUDGET = 1200;
const COMPOUND_PRIORITY_FEE_MICROLAMPORTS = parseInt(
  process.env.COMPOUND_PRIORITY_FEE_MICROLAMPORTS
    || String(Math.max(1, Math.round((config.ONE_TIME_PRIORITY_FEE || 0.000001) * 1e9 * 1000))),
  10,
);

let cachedProgramCtx = null;
async function getProgramContext(treasury) {
  if (cachedProgramCtx) return cachedProgramCtx;
  const cfg = resolveStakingConfig();
  if (!cfg.configured) {
    throw new Error('staking_not_configured');
  }
  const anchor = require('@coral-xyz/anchor');
  const idlPath = path.join(__dirname, '..', '..', 'staking-sdk', 'src', 'idl.json');
  const idl = JSON.parse(fs.readFileSync(idlPath, 'utf8'));
  const customIdl = { ...idl, address: cfg.programId.toBase58() };
  const wallet = {
    publicKey: treasury.publicKey,
    signTransaction: async (tx) => { tx.partialSign(treasury); return tx; },
    signAllTransactions: async (txs) => txs.map((tx) => { tx.partialSign(treasury); return tx; }),
  };
  const provider = new anchor.AnchorProvider(config.stakeConnection, wallet, {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
  const program = new anchor.Program(customIdl, provider);

  // Detect stake-mint token program once.
  const stakeMint = cfg.stakeMint;
  const info = await getAccountInfoCached(config.stakeConnection, stakeMint);
  if (!info) throw new Error('stake_mint_not_found_on_stake_cluster');
  const stakeTokenProgram = info.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;

  const stakeVault = getAssociatedTokenAddressSync(stakeMint, cfg.pool, true, stakeTokenProgram);
  const treasuryAta = getAssociatedTokenAddressSync(stakeMint, treasury.publicKey, false, stakeTokenProgram);

  cachedProgramCtx = {
    cfg,
    program,
    stakeMint,
    stakeTokenProgram,
    stakeVault,
    treasuryAta,
  };
  return cachedProgramCtx;
}

function findPositionPda(programId, pool, owner, nonce) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(nonce));
  return PublicKey.findProgramAddressSync(
    [Buffer.from('position'), pool.toBuffer(), owner.toBuffer(), buf],
    programId,
  )[0];
}

function findCheckpointPda(programId, position, rewardMintPda) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('checkpoint'), position.toBuffer(), rewardMintPda.toBuffer()],
    programId,
  )[0];
}

function packIxs(ixs, feePayer, blockhash, priorityIx) {
  const txs = [];
  let cur = new Transaction({ feePayer, recentBlockhash: blockhash });
  if (priorityIx) cur.add(priorityIx);

  const fits = (tx) => {
    try {
      return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length <= TX_PACKET_BUDGET;
    } catch {
      return false;
    }
  };

  for (const ix of ixs) {
    cur.add(ix);
    if (!fits(cur)) {
      cur.instructions.pop();
      const baseLen = priorityIx ? 1 : 0;
      if (cur.instructions.length === baseLen) {
        throw new Error('compound_ix_too_large');
      }
      txs.push(cur);
      cur = new Transaction({ feePayer, recentBlockhash: blockhash });
      if (priorityIx) cur.add(priorityIx);
      cur.add(ix);
    }
  }
  const baseLen = priorityIx ? 1 : 0;
  if (cur.instructions.length > baseLen) txs.push(cur);
  return txs;
}

/**
 * Prepare and send (stake_for + prime_checkpoint × N) for a single beneficiary.
 *
 * @param {object} opts
 * @param {Keypair} opts.treasury
 * @param {string|PublicKey} opts.beneficiary  user's wallet
 * @param {bigint|string|number} opts.amountRaw amount in raw stake-mint units
 * @param {number} opts.lockDays               1|3|7|14|21|30
 * @param {Array<{publicKey: PublicKey, account:{mint: PublicKey}}>} [opts.rewardMints]
 *        Optional pre-fetched reward mints for this pool. Falls back to a
 *        fresh `program.account.rewardMint.all()` scan if omitted.
 * @returns {Promise<{ position: string, nonce: string, signatures: string[] }>}
 */
async function stakeForCompound({
  treasury,
  beneficiary,
  amountRaw,
  lockDays,
  rewardMints = null,
}) {
  const ctx = await getProgramContext(treasury);
  const { cfg, program, stakeMint, stakeTokenProgram, stakeVault, treasuryAta } = ctx;
  const beneficiaryPk = beneficiary instanceof PublicKey ? beneficiary : new PublicKey(beneficiary);

  const amountStr = typeof amountRaw === 'bigint' ? amountRaw.toString() : String(amountRaw);
  if (BigInt(amountStr) <= 0n) {
    throw new Error('compound_amount_zero');
  }
  if (![1, 3, 7, 14, 21, 30].includes(lockDays)) {
    throw new Error('compound_invalid_lock_days');
  }

  // Reward mints — used to prime fresh checkpoints so the new position
  // accrues from the next deposit_rewards.
  let mints = rewardMints;
  if (!mints) {
    mints = await program.account.rewardMint.all([
      { memcmp: { offset: 8 + 1, bytes: cfg.pool.toBase58() } },
    ]);
  }

  const nonce = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
  const position = findPositionPda(cfg.programId, cfg.pool, beneficiaryPk, nonce);

  const ixs = [];
  ixs.push(
    await program.methods
      .stakeFor(new BN(amountStr), lockDays, new BN(nonce.toString()), beneficiaryPk)
      .accounts({
        pool: cfg.pool,
        stakeMint,
        stakeVault,
        payer: treasury.publicKey,
        payerTokenAccount: treasuryAta,
        position,
        tokenProgram: stakeTokenProgram,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .instruction(),
  );

  for (const rm of mints) {
    ixs.push(
      await program.methods
        .primeCheckpoint()
        .accounts({
          pool: cfg.pool,
          rewardMint: rm.publicKey,
          position,
          checkpoint: findCheckpointPda(cfg.programId, position, rm.publicKey),
          payer: treasury.publicKey,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .instruction(),
    );
  }

  const { blockhash } = await config.stakeConnection.getLatestBlockhash('confirmed');
  const priorityIx = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: COMPOUND_PRIORITY_FEE_MICROLAMPORTS,
  });
  const txs = packIxs(ixs, treasury.publicKey, blockhash, priorityIx);

  const signatures = [];
  for (const tx of txs) {
    const sig = await sendAndConfirmTransaction(config.stakeConnection, tx, [treasury], {
      commitment: 'confirmed',
      skipPreflight: false,
    });
    signatures.push(sig);
  }

  logEvent('info', 'Personalized compound staked', {
    wallet: beneficiaryPk.toBase58(),
    amountRaw: amountStr,
    lockDays,
    position: position.toBase58(),
    txs: signatures.length,
    rewardMints: mints.length,
  });

  return {
    position: position.toBase58(),
    nonce: nonce.toString(),
    signatures,
  };
}

/**
 * Pre-fetch reward mints once per cycle so we don't re-scan for every user.
 */
async function fetchPoolRewardMints(treasury) {
  const { cfg, program } = await getProgramContext(treasury);
  return program.account.rewardMint.all([
    { memcmp: { offset: 8 + 1, bytes: cfg.pool.toBase58() } },
  ]);
}

module.exports = {
  stakeForCompound,
  fetchPoolRewardMints,
};
