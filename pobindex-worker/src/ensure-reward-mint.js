'use strict';

/**
 * Idempotent on-chain registration of a reward mint against the pob-index-stake
 * pool. Safe to call every basket refresh; no-ops if the reward_mint PDA
 * already exists.
 *
 * Uses `config.stakeConnection` so the staking program can live on a different
 * cluster than discovery (e.g. devnet for testing).
 */

const path = require('path');
const {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} = require('@solana/spl-token');

const config = require('./config');
const { logEvent } = require('./utils');

function loadIdl(programId) {
  const idlPath = path.join(__dirname, '..', '..', 'staking-sdk', 'src', 'idl.json');
  // eslint-disable-next-line global-require
  const idl = require(idlPath);
  return { ...idl, address: programId.toBase58() };
}

async function detectTokenProgram(connection, mint) {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`Mint ${mint.toBase58()} not found on stake cluster`);
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  throw new Error(`Mint ${mint.toBase58()} not owned by a token program (owner=${info.owner.toBase58()})`);
}

/**
 * @param {object} opts
 * @param {string} opts.mintBase58
 * @param {import('@solana/web3.js').Keypair} opts.adminKeypair
 * @returns {Promise<{status: 'registered'|'already'|'skipped', signature?: string, tokenProgram?: string}>}
 */
async function ensureRewardMintRegistered({ mintBase58, adminKeypair, treasuryKeypair = null }) {
  if (!process.env.POB_STAKE_PROGRAM_ID || !process.env.POB_STAKE_MINT) {
    return { status: 'skipped' };
  }

  const anchor = require('@coral-xyz/anchor');
  const programId = new PublicKey(process.env.POB_STAKE_PROGRAM_ID);
  const stakeMint = new PublicKey(process.env.POB_STAKE_MINT);
  const rewardTokenMint = new PublicKey(mintBase58);

  const connection = config.stakeConnection;

  const idl = loadIdl(programId);
  const wallet = {
    publicKey: adminKeypair.publicKey,
    signTransaction: async (tx) => { tx.partialSign(adminKeypair); return tx; },
    signAllTransactions: async (txs) => txs.map((tx) => { tx.partialSign(adminKeypair); return tx; }),
  };
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
  const program = new anchor.Program(idl, provider);

  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), stakeMint.toBuffer()],
    programId,
  );
  const [rewardMintPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('reward'), pool.toBuffer(), rewardTokenMint.toBuffer()],
    programId,
  );

  // Idempotent fast-path: if already registered, just return.
  const existing = await program.account.rewardMint.fetchNullable(rewardMintPda);
  if (existing) {
    return { status: 'already', pda: rewardMintPda.toBase58() };
  }

  const tokenProgram = await detectTokenProgram(connection, rewardTokenMint);
  const rewardVault = getAssociatedTokenAddressSync(
    rewardTokenMint,
    pool,
    true,
    tokenProgram,
  );

  const sig = await program.methods
    .addRewardMint()
    .accounts({
      pool,
      authority: adminKeypair.publicKey,
      rewardTokenMint,
      rewardMint: rewardMintPda,
      rewardVault,
      tokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  const progLabel = tokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? 'Token-2022' : 'Legacy SPL';
  logEvent('info', 'Registered reward mint on pool', {
    mint: rewardTokenMint.toBase58(),
    tokenProgram: progLabel,
    signature: sig,
  });

  // CRITICAL: prime every existing position's checkpoint on this new reward
  // mint BEFORE any `deposit_rewards` bumps `acc_per_share`. The on-chain
  // claim handler's baseline-safe init (claim.rs) snapshots the *current*
  // acc_per_share when a position first claims a mint with no checkpoint —
  // so if we deposit before priming, existing stakers baseline post-deposit
  // and permanently miss that round's rewards.
  //
  // Priming is PERMISSIONLESS, so we pay rent from the treasury (Bank) when
  // it's available rather than draining the pool-authority (Brr). A busy
  // basket rotates several times per hour, and each rotation with ~120
  // positions would otherwise burn ~0.2 SOL of Brr — the exact leak that
  // made Brr fall below the admin-health floor and stop reward pushes.
  const primeResult = await primeAllPositions({
    program,
    pool,
    rewardMintPda,
    payer: treasuryKeypair || adminKeypair,
  });

  return {
    status: 'registered',
    signature: sig,
    tokenProgram: progLabel,
    pda: rewardMintPda.toBase58(),
    primed: primeResult,
  };
}

/**
 * Iterate every open `StakePosition` on the pool and call `prime_checkpoint`
 * for (position, newRewardMintPda). Skips positions that already have a
 * checkpoint (the on-chain handler is a no-op in that case, but skipping
 * client-side saves CU + RPC). Returns a summary suitable for logging.
 */
async function primeAllPositions({ program, pool, rewardMintPda, payer }) {
  const {
    PublicKey: Pk,
    Transaction,
    sendAndConfirmTransaction,
  } = require('@solana/web3.js');
  const connection = program.provider.connection;
  // Pool-scoped scan: offset 8 + 1 = 9 (skip discriminator + bump).
  const positions = (await program.account.stakePosition.all([
    { memcmp: { offset: 8 + 1, bytes: pool.toBase58() } },
  ])).filter((a) => a.account.pool.equals(pool) && !a.account.closed);

  const primed = [];
  const skipped = [];
  const failed = [];

  // Build ixs for missing checkpoints only. `prime_checkpoint` is
  // permissionless (the on-chain handler doesn't require any authority
  // signer), so we send the txs ourselves with `payer` — typically Bank —
  // bypassing whatever signer anchor's provider was built with. This keeps
  // Brr (pool authority) solvent across basket rotations.
  const toPrime = [];
  for (const pos of positions) {
    const [checkpointPda] = Pk.findProgramAddressSync(
      [Buffer.from('checkpoint'), pos.publicKey.toBuffer(), rewardMintPda.toBuffer()],
      program.programId,
    );
    const existing = await program.account.rewardCheckpoint.fetchNullable(checkpointPda);
    if (existing) {
      skipped.push(pos.publicKey.toBase58());
      continue;
    }
    toPrime.push({ position: pos.publicKey, checkpoint: checkpointPda });
  }

  for (const t of toPrime) {
    try {
      const ix = await program.methods
        .primeCheckpoint()
        .accounts({
          pool,
          rewardMint: rewardMintPda,
          position: t.position,
          checkpoint: t.checkpoint,
          payer: payer.publicKey,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .instruction();
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction({
        feePayer: payer.publicKey,
        blockhash,
        lastValidBlockHeight,
      }).add(ix);
      const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
        commitment: 'confirmed',
        skipPreflight: false,
      });
      primed.push({ position: t.position.toBase58(), signature: sig });
    } catch (e) {
      failed.push({ position: t.position.toBase58(), error: e.message || String(e) });
    }
  }

  logEvent('info', 'Primed reward checkpoints for existing positions', {
    rewardMint: rewardMintPda.toBase58(),
    primed: primed.length,
    skipped: skipped.length,
    failed: failed.length,
    payer: payer.publicKey.toBase58(),
  });

  return { primed, skipped, failed };
}

module.exports = {
  ensureRewardMintRegistered,
};
