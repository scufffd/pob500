#!/usr/bin/env node
'use strict';

/**
 * Admin script for the pob-index-stake pool. Signs with TREASURY_PRIVATE_KEY
 * (or ADMIN_PRIVATE_KEY if set). Uses config.stakeConnection.
 *
 * Usage:
 *   npm run stake:init
 *   npm run stake:add-reward -- <REWARD_MINT>
 *   npm run stake:sync-rewards                      # adds a RewardMint account for every
 *                                                     # mint in the latest POB snapshot
 */

const path = require('path');
const fs = require('fs');
const { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} = require('@solana/spl-token');

const config = require('../src/config');

function loadIdl(programId) {
  const idlPath = path.join(__dirname, '..', '..', 'staking-sdk', 'src', 'idl.json');
  const idl = JSON.parse(fs.readFileSync(idlPath, 'utf8'));
  return { ...idl, address: programId.toBase58() };
}

function getAdminKey() {
  return config.parsePrivateKey(
    process.env.ADMIN_PRIVATE_KEY || config.requireEnv('TREASURY_PRIVATE_KEY'),
  );
}

async function detectTokenProgram(connection, mint) {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`Mint ${mint.toBase58()} not found on cluster`);
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  throw new Error(`Mint ${mint.toBase58()} not owned by a token program (owner=${info.owner.toBase58()})`);
}

async function getProgramContext() {
  const programIdStr = config.requireEnv('POB_STAKE_PROGRAM_ID');
  const stakeMintStr = config.requireEnv('POB_STAKE_MINT');
  const programId = new PublicKey(programIdStr);
  const stakeMint = new PublicKey(stakeMintStr);
  const admin = getAdminKey();

  const anchor = require('@coral-xyz/anchor');
  const idl = loadIdl(programId);
  const wallet = {
    publicKey: admin.publicKey,
    signTransaction: async (tx) => { tx.partialSign(admin); return tx; },
    signAllTransactions: async (txs) => txs.map((tx) => { tx.partialSign(admin); return tx; }),
  };
  const provider = new anchor.AnchorProvider(config.stakeConnection, wallet, {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
  const program = new anchor.Program(idl, provider);

  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), stakeMint.toBuffer()],
    programId,
  );

  const stakeTokenProgram = await detectTokenProgram(config.stakeConnection, stakeMint);

  return { anchor, program, admin, programId, stakeMint, pool, stakeTokenProgram };
}

async function initializePool() {
  const { program, admin, stakeMint, pool, stakeTokenProgram } = await getProgramContext();
  console.log('Initializing pool', {
    pool: pool.toBase58(),
    stakeMint: stakeMint.toBase58(),
    stakeTokenProgram: stakeTokenProgram.toBase58(),
  });

  const existing = await program.account.stakePool.fetchNullable(pool);
  if (existing) {
    console.log('Pool already initialized.');
    return;
  }

  const stakeVault = getAssociatedTokenAddressSync(stakeMint, pool, true, stakeTokenProgram);
  const sig = await program.methods
    .initializePool()
    .accounts({
      authority: admin.publicKey,
      stakeMint,
      pool,
      stakeVault,
      tokenProgram: stakeTokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();
  console.log('Pool initialized · sig', sig);
}

async function addRewardMint(rewardMintStr) {
  if (!rewardMintStr) throw new Error('Usage: stake:add-reward -- <REWARD_MINT>');
  const { program, admin, programId, pool } = await getProgramContext();
  const rewardTokenMint = new PublicKey(rewardMintStr);
  const tokenProgram = await detectTokenProgram(config.stakeConnection, rewardTokenMint);
  const [rewardMintPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('reward'), pool.toBuffer(), rewardTokenMint.toBuffer()],
    programId,
  );
  const rewardVault = getAssociatedTokenAddressSync(rewardTokenMint, pool, true, tokenProgram);

  const existing = await program.account.rewardMint.fetchNullable(rewardMintPda);
  if (existing) {
    console.log('Reward mint already registered', rewardTokenMint.toBase58());
    return;
  }

  const sig = await program.methods
    .addRewardMint()
    .accounts({
      pool,
      authority: admin.publicKey,
      rewardTokenMint,
      rewardMint: rewardMintPda,
      rewardVault,
      tokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();
  console.log(
    'Added reward mint',
    rewardTokenMint.toBase58(),
    '(', tokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? 'Token-2022' : 'Legacy SPL', ')',
    'sig', sig,
  );

  // Prime every existing position BEFORE any deposit_rewards — same rationale
  // as in `ensure-reward-mint.js`. If this script is run on a pool that
  // already has stakers (e.g. adding a new reward line mid-life), skipping
  // this step would cause those stakers to baseline post-deposit and miss
  // the round's rewards. Permissionless + idempotent, so safe to always run.
  const positions = (await program.account.stakePosition.all([
    { memcmp: { offset: 8 + 1, bytes: pool.toBase58() } },
  ])).filter((a) => a.account.pool.equals(pool) && !a.account.closed);
  if (positions.length > 0) {
    console.log(`Priming ${positions.length} existing position(s) on new reward mint…`);
    for (const pos of positions) {
      const [checkpointPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('checkpoint'), pos.publicKey.toBuffer(), rewardMintPda.toBuffer()],
        programId,
      );
      const existingCp = await program.account.rewardCheckpoint.fetchNullable(checkpointPda);
      if (existingCp) continue;
      const primeSig = await program.methods
        .primeCheckpoint()
        .accounts({
          pool,
          rewardMint: rewardMintPda,
          position: pos.publicKey,
          checkpoint: checkpointPda,
          payer: admin.publicKey,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();
      console.log('  primed', pos.publicKey.toBase58(), '·', primeSig);
    }
  }
}

/**
 * Register the stake mint itself as a reward mint. This is a one-time setup
 * step required before any user can call `unstake_early` — the penalty is
 * redistributed through this reward line, so its PDA + vault must exist.
 */
async function registerStakeMintAsReward() {
  const { stakeMint } = await getProgramContext();
  console.log('Registering stake mint as a reward mint (for early-unstake penalty redistribution):');
  console.log('  stake mint:', stakeMint.toBase58());
  await addRewardMint(stakeMint.toBase58());
}

async function syncRewardMintsFromSnapshot() {
  const snapshotPath = config.POBINDEX_DATA_JSON;
  if (!fs.existsSync(snapshotPath)) {
    throw new Error(`Snapshot not found at ${snapshotPath}. Run \`npm run cycle\` or \`npm run discover\` first.`);
  }
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const mints = (snapshot.tokens || []).map((t) => t.mint).filter(Boolean);
  console.log(`Syncing ${mints.length} mint(s) from snapshot…`);
  for (const mint of mints) {
    try {
      await addRewardMint(mint);
    } catch (e) {
      console.error('Failed to add', mint, e.message || e);
    }
  }
}

async function main() {
  const [, , cmd, arg] = process.argv;
  try {
    if (cmd === 'init') await initializePool();
    else if (cmd === 'add-reward') await addRewardMint(arg);
    else if (cmd === 'sync-rewards') await syncRewardMintsFromSnapshot();
    else if (cmd === 'register-stake-reward') await registerStakeMintAsReward();
    else {
      console.error('Unknown command. Use: init | add-reward <MINT> | sync-rewards | register-stake-reward');
      process.exit(2);
    }
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

main();
