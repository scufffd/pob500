#!/usr/bin/env node
'use strict';

/**
 * test-early-unstake.js — devnet end-to-end verification of the early-unstake
 * + penalty-redistribution flow.
 *
 * Flow:
 *   1. Creates two fresh test wallets, funds them with SOL + POB stake tokens
 *      from treasury.
 *   2. Each wallet stakes the same amount at the 30-day tier.
 *   3. Wallet A calls `unstake_early`:
 *        - asserts refund   == amount * 0.90
 *        - asserts penalty  == amount * 0.10
 *        - asserts pool.total_staked / total_effective decreased by A's share
 *        - asserts stake_reward_mint.acc_per_share incremented by
 *          penalty * 1e18 / new_total_effective
 *   4. Wallet B claims from the stake-mint reward line and asserts the
 *      observed ATA delta matches the expected redistribution.
 *
 * Requires env:
 *   STAKE_RPC_URL (devnet)   TREASURY_PRIVATE_KEY
 *   POB_STAKE_PROGRAM_ID     POB_STAKE_MINT (treasury must hold enough)
 *
 * Run:
 *   npm run test:early-unstake
 *   npm run test:early-unstake -- --stake 2000
 */

const path = require('path');
const fs = require('fs');
const {
  PublicKey,
  Keypair,
  Transaction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAccount,
  getOrCreateAssociatedTokenAccount,
} = require('@solana/spl-token');
const BN = require('bn.js');

const config = require('../src/config');

const LOCK_DAYS = 30;
const MULT_BPS = 30_000;
const PENALTY_BPS = 1_000;
const ACC_PRECISION = 1_000_000_000_000_000_000n;

function parseArgs(argv) {
  const out = { stakeAmount: 1000 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[i + 1];
    if (a === '--stake') { out.stakeAmount = parseFloat(next()); i += 1; }
  }
  return out;
}

function loadIdl(programId) {
  const idlPath = path.join(__dirname, '..', '..', 'staking-sdk', 'src', 'idl.json');
  const idl = JSON.parse(fs.readFileSync(idlPath, 'utf8'));
  return { ...idl, address: programId.toBase58() };
}

function buildProvider(connection, signerKeypair) {
  const anchor = require('@coral-xyz/anchor');
  const wallet = {
    publicKey: signerKeypair.publicKey,
    signTransaction: async (tx) => { tx.partialSign(signerKeypair); return tx; },
    signAllTransactions: async (txs) => txs.map((tx) => { tx.partialSign(signerKeypair); return tx; }),
  };
  return new anchor.AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
}

function loadProgram(provider, programId) {
  const anchor = require('@coral-xyz/anchor');
  const idl = loadIdl(programId);
  return new anchor.Program(idl, provider);
}

function findPoolPda(programId, stakeMint) {
  return PublicKey.findProgramAddressSync([Buffer.from('pool'), stakeMint.toBuffer()], programId)[0];
}
function findRewardMintPda(programId, pool, mint) {
  return PublicKey.findProgramAddressSync([Buffer.from('reward'), pool.toBuffer(), mint.toBuffer()], programId)[0];
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

async function ensureFunded(connection, treasury, pubkey, minSol) {
  const b = await connection.getBalance(pubkey);
  if (b >= Math.round(minSol * LAMPORTS_PER_SOL)) return;
  const needLamports = Math.round(minSol * LAMPORTS_PER_SOL);
  const tBal = await connection.getBalance(treasury.publicKey);
  if (tBal > needLamports + 10_000_000) {
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: treasury.publicKey, toPubkey: pubkey, lamports: needLamports }),
    );
    await sendAndConfirmTransaction(connection, tx, [treasury], { commitment: 'confirmed' });
    return;
  }
  const sig = await connection.requestAirdrop(pubkey, needLamports);
  await connection.confirmTransaction(sig, 'confirmed');
}

function assertEq(label, actual, expected) {
  const a = BigInt(actual);
  const e = BigInt(expected);
  if (a !== e) {
    console.error(`FAIL ${label}: got ${a}, expected ${e}`);
    process.exit(5);
  }
  console.log(`  PASS ${label} · ${a}`);
}

function assertNear(label, actual, expected, slack = 1n) {
  const a = BigInt(actual);
  const e = BigInt(expected);
  const d = a > e ? a - e : e - a;
  if (d > slack) {
    console.error(`FAIL ${label}: got ${a}, expected ${e}, diff ${d} > slack ${slack}`);
    process.exit(5);
  }
  console.log(`  PASS ${label} · ${a} (expected ${e}, diff ${d})`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connection = config.stakeConnection;
  const rpcUrl = config.STAKE_RPC_URL;

  console.log('— POB early-unstake + penalty redistribution test —');
  console.log('cluster          :', rpcUrl);
  if (!/devnet|localhost/i.test(rpcUrl)) {
    console.error('Refusing to run: STAKE_RPC_URL is not devnet/localhost.');
    process.exit(2);
  }

  const treasury = config.parsePrivateKey(config.requireEnv('TREASURY_PRIVATE_KEY'));
  const programId = new PublicKey(config.requireEnv('POB_STAKE_PROGRAM_ID'));
  const stakeMint = new PublicKey(config.requireEnv('POB_STAKE_MINT'));
  const pool = findPoolPda(programId, stakeMint);
  const stakeRewardMintPda = findRewardMintPda(programId, pool, stakeMint);

  console.log('programId        :', programId.toBase58());
  console.log('stakeMint        :', stakeMint.toBase58());
  console.log('pool             :', pool.toBase58());
  console.log('stakeRewardMint  :', stakeRewardMintPda.toBase58());

  const provider = buildProvider(connection, treasury);
  const program = loadProgram(provider, programId);

  // Pool must exist + stake mint must be registered as a reward mint.
  const poolAcc = await program.account.stakePool.fetchNullable(pool);
  if (!poolAcc) { console.error('Pool not initialized.'); process.exit(3); }

  const stakeRewardAcc = await program.account.rewardMint.fetchNullable(stakeRewardMintPda);
  if (!stakeRewardAcc) {
    console.error('Stake-mint reward line not registered. Run `npm run stake:register-stake-reward`.');
    process.exit(3);
  }

  const stakeMintInfo = await connection.getParsedAccountInfo(stakeMint);
  const stakeDecimals = stakeMintInfo.value?.data?.parsed?.info?.decimals ?? 9;
  const stakeUnits = BigInt(Math.round(args.stakeAmount * 10 ** stakeDecimals));
  console.log('stake per wallet :', args.stakeAmount, `(${stakeUnits} raw)`);

  const treasuryStakeAta = getAssociatedTokenAddressSync(stakeMint, treasury.publicKey);
  const treasuryBal = BigInt((await getAccount(connection, treasuryStakeAta)).amount);
  if (treasuryBal < stakeUnits * 2n) {
    console.error(`Treasury has ${treasuryBal}, needs ${stakeUnits * 2n}`);
    process.exit(3);
  }

  // ── Create wallets A (will early-unstake) and B (remains, claims) ──────────
  const walletA = Keypair.generate();
  const walletB = Keypair.generate();
  console.log('walletA (exits)  :', walletA.publicKey.toBase58());
  console.log('walletB (claims) :', walletB.publicKey.toBase58());

  await ensureFunded(connection, treasury, walletA.publicKey, 0.05);
  await ensureFunded(connection, treasury, walletB.publicKey, 0.05);

  // Fund both wallets with stake tokens.
  for (const [idx, kp] of [['A', walletA], ['B', walletB]]) {
    const userAta = getAssociatedTokenAddressSync(stakeMint, kp.publicKey);
    const tx = new Transaction();
    tx.add(createAssociatedTokenAccountInstruction(treasury.publicKey, userAta, kp.publicKey, stakeMint));
    tx.add(createTransferInstruction(treasuryStakeAta, userAta, treasury.publicKey, stakeUnits));
    const sig = await sendAndConfirmTransaction(connection, tx, [treasury], { commitment: 'confirmed' });
    console.log(`  funded wallet${idx} · ${sig.slice(0, 12)}…`);
  }

  // ── Both stake ─────────────────────────────────────────────────────────────
  console.log(`\n[1/4] Staking ${stakeUnits} from each wallet at ${LOCK_DAYS}d (${MULT_BPS / 10_000}×)…`);
  const stakePositions = {};
  for (const [label, kp] of [['A', walletA], ['B', walletB]]) {
    const userAta = getAssociatedTokenAddressSync(stakeMint, kp.publicKey);
    const nonce = BigInt(Date.now()) * 1000n + (label === 'A' ? 0n : 1n);
    const position = findPositionPda(programId, pool, kp.publicKey, nonce);
    const walletProgram = loadProgram(buildProvider(connection, kp), programId);
    const sig = await walletProgram.methods
      .stake(new BN(stakeUnits.toString()), LOCK_DAYS, new BN(nonce.toString()))
      .accounts({
        pool,
        stakeMint,
        stakeVault: poolAcc.stakeVault,
        owner: kp.publicKey,
        userTokenAccount: userAta,
        position,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    stakePositions[label] = { kp, userAta, nonce, position };
    console.log(`  wallet${label} staked · ${sig.slice(0, 12)}… position=${position.toBase58().slice(0, 10)}…`);
  }

  // ── Snapshot pool + reward state before early unstake ──────────────────────
  const poolBefore = await program.account.stakePool.fetch(pool);
  const rewardBefore = await program.account.rewardMint.fetch(stakeRewardMintPda);

  const posA = await program.account.stakePosition.fetch(stakePositions.A.position);
  const effectiveA = BigInt(posA.effective.toString());
  const totalEffectiveBefore = BigInt(poolBefore.totalEffective.toString());
  const totalStakedBefore = BigInt(poolBefore.totalStaked.toString());
  const rewardAccBefore = BigInt(rewardBefore.accPerShare.toString());
  const rewardDepositedBefore = BigInt(rewardBefore.totalDeposited.toString());

  console.log('\n  snapshot before unstake_early:');
  console.log('    pool.total_staked   :', totalStakedBefore.toString());
  console.log('    pool.total_effective:', totalEffectiveBefore.toString());
  console.log('    reward.acc_per_share:', rewardAccBefore.toString());
  console.log('    reward.deposited    :', rewardDepositedBefore.toString());
  console.log('    posA.amount         :', BigInt(posA.amount.toString()).toString());
  console.log('    posA.effective      :', effectiveA.toString());

  // ── [2/4] Wallet A early-unstakes ──────────────────────────────────────────
  console.log('\n[2/4] Wallet A calls unstake_early…');
  const amountA = BigInt(posA.amount.toString());
  const expectedPenalty = (amountA * BigInt(PENALTY_BPS)) / 10_000n;
  const expectedRefund = amountA - expectedPenalty;
  const expectedTotalEffectiveAfter = totalEffectiveBefore - effectiveA;
  const expectedAccDelta = expectedTotalEffectiveAfter > 0n
    ? (expectedPenalty * ACC_PRECISION) / expectedTotalEffectiveAfter
    : 0n;
  const expectedAccAfter = rewardAccBefore + expectedAccDelta;

  const ataABefore = BigInt((await getAccount(connection, stakePositions.A.userAta)).amount);

  const walletProgramA = loadProgram(buildProvider(connection, walletA), programId);
  const unstakeEarlySig = await walletProgramA.methods
    .unstakeEarly()
    .accounts({
      pool,
      stakeMint,
      stakeVault: poolAcc.stakeVault,
      stakeRewardMint: stakeRewardMintPda,
      position: stakePositions.A.position,
      owner: walletA.publicKey,
      userTokenAccount: stakePositions.A.userAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  console.log(`  unstake_early · ${unstakeEarlySig}`);

  const ataAAfter = BigInt((await getAccount(connection, stakePositions.A.userAta)).amount);
  const refundObserved = ataAAfter - ataABefore;

  const poolAfter = await program.account.stakePool.fetch(pool);
  const rewardAfter = await program.account.rewardMint.fetch(stakeRewardMintPda);

  console.log('\n[3/4] Verifying penalty math…');
  assertEq('wallet A refund observed', refundObserved, expectedRefund);
  assertEq('pool.total_staked decreased by full amount', poolAfter.totalStaked, totalStakedBefore - amountA);
  assertEq('pool.total_effective decreased by full effective', poolAfter.totalEffective, expectedTotalEffectiveAfter);
  assertEq('reward.total_deposited += penalty', rewardAfter.totalDeposited, rewardDepositedBefore + expectedPenalty);
  assertEq('reward.acc_per_share bumped correctly', rewardAfter.accPerShare, expectedAccAfter);

  // Position A should be closed (account gone).
  const posAAfter = await program.account.stakePosition.fetchNullable(stakePositions.A.position);
  if (posAAfter !== null) {
    console.error('FAIL position A was not closed');
    process.exit(5);
  }
  console.log('  PASS position A closed · account no longer exists');

  // ── [4/4] Wallet B claims from the stake-mint reward line ──────────────────
  console.log('\n[4/4] Wallet B claims from the stake-mint reward line…');
  const posB = await program.account.stakePosition.fetch(stakePositions.B.position);
  const effectiveB = BigInt(posB.effective.toString());
  // Prior total_effective (before A left) actually doesn't matter for B's claim;
  // B's checkpoint starts at 0 (first claim), so pending = acc_per_share(after A exits)
  // * effective_B / 1e18.
  const expectedB = (BigInt(rewardAfter.accPerShare.toString()) * effectiveB) / ACC_PRECISION;
  console.log('  expected B payout   :', expectedB.toString(), 'raw POB');

  const walletProgramB = loadProgram(buildProvider(connection, walletB), programId);
  const checkpointB = findCheckpointPda(programId, stakePositions.B.position, stakeRewardMintPda);
  const ataBBefore = BigInt((await getAccount(connection, stakePositions.B.userAta)).amount);

  const claimSig = await walletProgramB.methods
    .claim()
    .accounts({
      pool,
      rewardMint: stakeRewardMintPda,
      mint: stakeMint,
      vault: poolAcc.stakeVault, // stake-mint reward vault == stake_vault
      position: stakePositions.B.position,
      owner: walletB.publicKey,
      checkpoint: checkpointB,
      userTokenAccount: stakePositions.B.userAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();
  console.log(`  claim · ${claimSig}`);

  const ataBAfter = BigInt((await getAccount(connection, stakePositions.B.userAta)).amount);
  const deltaB = ataBAfter - ataBBefore;

  // B may only own PART of the pool's total_effective (if other stakers exist
  // from prior test runs). Expected B payout ≈ acc_per_share_after * effective_B
  // / 1e18 which is exactly what we computed. Allow 1 unit rounding slack.
  assertNear('wallet B observed payout', deltaB, expectedB, 1n);

  // Sanity: penalty should almost entirely land on B if B is the only other staker.
  if (expectedTotalEffectiveAfter === effectiveB) {
    const lost = expectedPenalty - deltaB;
    console.log(`  B absorbed ${deltaB}/${expectedPenalty} of penalty (rounding loss ${lost})`);
  } else {
    const share = Number(effectiveB) / Number(expectedTotalEffectiveAfter);
    console.log(
      `  pool has other stakers · B's share: ${(share * 100).toFixed(4)}% · ` +
      `B claimed ${deltaB} of ${expectedPenalty} penalty`,
    );
  }

  console.log('\nPASS — early unstake math + redistribution verified.');
}

main().catch((e) => {
  console.error('\nFAIL', e.message || e);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
