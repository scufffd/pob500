#!/usr/bin/env node
'use strict';

/**
 * test-staking-math.js — devnet end-to-end assertion of the reward math.
 *
 * Flow:
 *   1. Creates a fresh SPL mint on devnet (mock reward mint) owned by treasury.
 *   2. Registers it on the pool via add_reward_mint.
 *   3. Creates N fresh test wallets (one per LOCK_TIERS entry by default), air-
 *      drops them a bit of devnet SOL, and funds each from treasury's POB stake
 *      mint balance.
 *   4. Each test wallet stakes the same amount at a different lock tier.
 *   5. Treasury mints a known REWARD_AMOUNT and calls deposit_rewards.
 *   6. Computes expected pending per position using the same on-chain formula
 *      (deposit * effective / total_effective) and compares against either:
 *        - the SDK's computePending() on the current accumulator, and
 *        - the observed ATA delta after calling claim().
 *   7. Prints a results table and exits non-zero on any mismatch.
 *
 * Requires env:
 *   STAKE_RPC_URL (devnet)     TREASURY_PRIVATE_KEY
 *   POB_STAKE_PROGRAM_ID       POB_STAKE_MINT (treasury must hold enough)
 *
 * Run:
 *   npm run test:staking
 *   npm run test:staking -- --lock-days 7,30,90 --stake 1000 --reward 1000000
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
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAccount,
} = require('@solana/spl-token');
const BN = require('bn.js');

const config = require('../src/config');

const LOCK_TIER_MULTIPLIER_BPS = {
  1: 10000,
  3: 12500,
  7: 15000,
  14: 20000,
  21: 25000,
  30: 30000,
};

function parseArgs(argv) {
  const out = {
    lockDays: [1, 7, 30],
    stakeAmount: 1000,       // in whole POB stake units (decimals unknown → we scale later)
    rewardAmount: 1_000_000, // raw units
    keepWallets: false,
    tokenProgram: 'legacy',  // 'legacy' | 'token2022'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[i + 1];
    if (a === '--lock-days') { out.lockDays = next().split(',').map(Number); i += 1; }
    else if (a === '--stake') { out.stakeAmount = parseFloat(next()); i += 1; }
    else if (a === '--reward') { out.rewardAmount = parseFloat(next()); i += 1; }
    else if (a === '--keep-wallets') { out.keepWallets = true; }
    else if (a === '--token-program') { out.tokenProgram = next(); i += 1; }
  }
  return out;
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
  const idlPath = path.join(__dirname, '..', '..', 'staking-sdk', 'src', 'idl.json');
  const idl = JSON.parse(fs.readFileSync(idlPath, 'utf8'));
  const customIdl = { ...idl, address: programId.toBase58() };
  return new anchor.Program(customIdl, provider);
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

async function fundSolFromTreasury(connection, treasury, pubkey, sol) {
  const lamports = Math.round(sol * LAMPORTS_PER_SOL);
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: treasury.publicKey,
      toPubkey: pubkey,
      lamports,
    }),
  );
  return sendAndConfirmTransaction(connection, tx, [treasury], { commitment: 'confirmed' });
}

async function ensureFunded(connection, treasury, pubkey, minSol) {
  const b = await connection.getBalance(pubkey);
  if (b >= Math.round(minSol * LAMPORTS_PER_SOL)) return;
  // Try treasury transfer first (reliable); fall back to faucet if treasury is too low.
  const tBal = await connection.getBalance(treasury.publicKey);
  const needLamports = Math.round(minSol * LAMPORTS_PER_SOL);
  if (tBal > needLamports + 10_000_000) {
    await fundSolFromTreasury(connection, treasury, pubkey, minSol);
    return;
  }
  const sig = await connection.requestAirdrop(pubkey, needLamports);
  await connection.confirmTransaction(sig, 'confirmed');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connection = config.stakeConnection;
  const rpcUrl = config.STAKE_RPC_URL;

  console.log('— POB staking math test —');
  console.log('cluster          :', rpcUrl);
  if (!/devnet|localhost/i.test(rpcUrl)) {
    console.error('Refusing to run: STAKE_RPC_URL is not devnet/localhost. Set STAKE_RPC_URL=https://api.devnet.solana.com first.');
    process.exit(2);
  }

  for (const d of args.lockDays) {
    if (!LOCK_TIER_MULTIPLIER_BPS[d]) {
      console.error(`Invalid lock tier: ${d}. Allowed: ${Object.keys(LOCK_TIER_MULTIPLIER_BPS).join(', ')}`);
      process.exit(2);
    }
  }

  const treasury = config.parsePrivateKey(config.requireEnv('TREASURY_PRIVATE_KEY'));
  const programId = new PublicKey(config.requireEnv('POB_STAKE_PROGRAM_ID'));
  const stakeMint = new PublicKey(config.requireEnv('POB_STAKE_MINT'));
  const pool = findPoolPda(programId, stakeMint);

  console.log('treasury         :', treasury.publicKey.toBase58());
  console.log('programId        :', programId.toBase58());
  console.log('stakeMint        :', stakeMint.toBase58());
  console.log('pool             :', pool.toBase58());

  const provider = buildProvider(connection, treasury);
  const program = loadProgram(provider, programId);

  // ── Pre-flight: pool must exist ────────────────────────────────────────────
  const poolAcc = await program.account.stakePool.fetchNullable(pool);
  if (!poolAcc) {
    console.error('Pool not initialized. Run `npm run stake:init` first.');
    process.exit(3);
  }

  // Read stake mint decimals so we scale the stake amount correctly.
  const stakeMintInfo = await connection.getParsedAccountInfo(stakeMint);
  const stakeDecimals = stakeMintInfo.value?.data?.parsed?.info?.decimals;
  if (stakeDecimals == null) {
    console.error('Could not parse stake mint decimals.');
    process.exit(3);
  }
  const stakeUnits = BigInt(Math.round(args.stakeAmount * 10 ** stakeDecimals));
  console.log('stake per wallet :', args.stakeAmount, `(${stakeUnits} raw, ${stakeDecimals} dec)`);

  // Check treasury has enough stake tokens to fund N wallets.
  const treasuryStakeAta = getAssociatedTokenAddressSync(stakeMint, treasury.publicKey);
  let treasuryStakeBal = 0n;
  try {
    const acc = await getAccount(connection, treasuryStakeAta);
    treasuryStakeBal = acc.amount;
  } catch {
    console.error('Treasury has no stake mint ATA / balance. Fund it first.');
    process.exit(3);
  }
  const needed = stakeUnits * BigInt(args.lockDays.length);
  if (treasuryStakeBal < needed) {
    console.error(`Treasury balance insufficient: has ${treasuryStakeBal}, needs ${needed}`);
    process.exit(3);
  }
  console.log('treasury stake   :', treasuryStakeBal.toString(), '(raw)');

  // ── Step 1: Create a fresh mock reward mint on devnet ──────────────────────
  const rewardTokenProgram = args.tokenProgram === 'token2022'
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;
  const rewardTokenProgramLabel = args.tokenProgram === 'token2022' ? 'Token-2022' : 'Legacy SPL';
  console.log(`\n[1/6] Creating mock reward mint (${rewardTokenProgramLabel}, treasury = mint authority)…`);
  const rewardDecimals = 6;
  const rewardMint = await createMint(
    connection,
    treasury,            // payer
    treasury.publicKey,  // mint authority
    null,                // freeze authority
    rewardDecimals,
    undefined,
    { commitment: 'confirmed' },
    rewardTokenProgram,
  );
  console.log('  rewardMint      :', rewardMint.toBase58());

  // ── Step 2: add_reward_mint ───────────────────────────────────────────────
  console.log('\n[2/6] Registering reward mint on pool…');
  const rewardMintPda = findRewardMintPda(programId, pool, rewardMint);
  const rewardVault = getAssociatedTokenAddressSync(rewardMint, pool, true, rewardTokenProgram);
  const addSig = await program.methods
    .addRewardMint()
    .accounts({
      pool,
      authority: treasury.publicKey,
      rewardTokenMint: rewardMint,
      rewardMint: rewardMintPda,
      rewardVault,
      tokenProgram: rewardTokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();
  console.log('  add_reward_mint ·', addSig);

  // ── Step 3: Create test wallets, airdrop SOL, fund stake mint ──────────────
  console.log(`\n[3/6] Creating ${args.lockDays.length} test wallets…`);
  const wallets = args.lockDays.map((days, idx) => {
    const kp = Keypair.generate();
    return { idx, days, kp, multiplierBps: LOCK_TIER_MULTIPLIER_BPS[days] };
  });

  for (const w of wallets) {
    console.log(`  wallet[${w.idx}] ${w.kp.publicKey.toBase58().slice(0, 8)}… lockDays=${w.days}`);
    await ensureFunded(connection, treasury, w.kp.publicKey, 0.05);
  }

  // Fund each test wallet's stake ATA from treasury.
  console.log('  transferring stake tokens from treasury…');
  for (const w of wallets) {
    const userAta = getAssociatedTokenAddressSync(stakeMint, w.kp.publicKey);
    const tx = new Transaction();
    // ATA may not exist yet on the test wallet
    tx.add(
      createAssociatedTokenAccountInstruction(
        treasury.publicKey,
        userAta,
        w.kp.publicKey,
        stakeMint,
      ),
    );
    tx.add(
      createTransferInstruction(
        treasuryStakeAta,
        userAta,
        treasury.publicKey,
        stakeUnits,
      ),
    );
    const sig = await sendAndConfirmTransaction(connection, tx, [treasury], { commitment: 'confirmed' });
    w.userStakeAta = userAta;
    console.log(`    wallet[${w.idx}] funded · ${sig.slice(0, 12)}…`);
  }

  // ── Step 4: Each wallet stakes at its lock tier ────────────────────────────
  console.log('\n[4/6] Staking from each test wallet…');
  for (const w of wallets) {
    const nonce = BigInt(Date.now()) * 1000n + BigInt(w.idx);
    const position = findPositionPda(programId, pool, w.kp.publicKey, nonce);
    const walletProvider = buildProvider(connection, w.kp);
    const walletProgram = loadProgram(walletProvider, programId);
    const sig = await walletProgram.methods
      .stake(new BN(stakeUnits.toString()), w.days, new BN(nonce.toString()))
      .accounts({
        pool,
        stakeMint,
        stakeVault: poolAcc.stakeVault,
        owner: w.kp.publicKey,
        userTokenAccount: w.userStakeAta,
        position,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    w.position = position;
    w.nonce = nonce;
    console.log(`  wallet[${w.idx}] stake · ${sig.slice(0, 12)}… position=${position.toBase58().slice(0, 10)}…`);
  }

  // ── Step 5: Deposit known reward amount ────────────────────────────────────
  console.log('\n[5/6] Minting + depositing mock rewards…');
  const treasuryRewardAta = (await getOrCreateAssociatedTokenAccount(
    connection,
    treasury,
    rewardMint,
    treasury.publicKey,
    false,
    'confirmed',
    undefined,
    rewardTokenProgram,
  )).address;
  const depositRaw = BigInt(Math.round(args.rewardAmount));
  await mintTo(
    connection, treasury, rewardMint, treasuryRewardAta, treasury, depositRaw,
    [], { commitment: 'confirmed' }, rewardTokenProgram,
  );
  console.log('  minted         :', depositRaw.toString(), 'raw to treasury ATA');

  const depositSig = await program.methods
    .depositRewards(new BN(depositRaw.toString()))
    .accounts({
      pool,
      rewardMint: rewardMintPda,
      mint: rewardMint,
      vault: rewardVault,
      funder: treasury.publicKey,
      funderTokenAccount: treasuryRewardAta,
      tokenProgram: rewardTokenProgram,
    })
    .rpc();
  console.log('  deposit_rewards ·', depositSig);

  // ── Step 6: Verify math ────────────────────────────────────────────────────
  console.log('\n[6/6] Verifying math…');

  // Refetch pool + reward_mint after deposit.
  const rewardAcc = await program.account.rewardMint.fetch(rewardMintPda);
  const poolAfter = await program.account.stakePool.fetch(pool);
  const accPerShare = BigInt(rewardAcc.accPerShare.toString());
  const totalEffective = BigInt(poolAfter.totalEffective.toString());
  console.log('  accPerShare     :', accPerShare.toString());
  console.log('  totalEffective  :', totalEffective.toString());

  // Compute effective for each test position from its own on-chain account so
  // we cross-check the on-chain multiplier math too. Pool may contain positions
  // from prior runs — our share is just our_effective / pool.totalEffective.
  const rows = [];
  let sumExpected = 0n;
  let sumMyEffective = 0n;
  for (const w of wallets) {
    const pos = await program.account.stakePosition.fetch(w.position);
    const effective = BigInt(pos.effective.toString());
    sumMyEffective += effective;
    if (pos.multiplierBps !== w.multiplierBps) {
      console.error(`FAIL multiplier mismatch for wallet[${w.idx}]: on-chain=${pos.multiplierBps}, expected=${w.multiplierBps}`);
      process.exit(5);
    }
    // Verify on-chain effective matches amount * mult / 10000 exactly.
    const amt = BigInt(pos.amount.toString());
    const expEffective = (amt * BigInt(w.multiplierBps)) / 10_000n;
    if (effective !== expEffective) {
      console.error(`FAIL effective math for wallet[${w.idx}]: on-chain=${effective}, expected=${expEffective}`);
      process.exit(5);
    }
    // computePending formula (pool acc - 0 checkpoint, claimable=0):
    const expected = (accPerShare * effective) / 1_000_000_000_000_000_000n;
    sumExpected += expected;
    rows.push({ w, pos, effective, expected });
  }

  const myShareBps = Number((sumMyEffective * 10_000n) / totalEffective);
  console.log(`  my effective    : ${sumMyEffective} (${(myShareBps / 100).toFixed(2)}% of pool)`);
  console.log(`  other stakers   : ${(totalEffective - sumMyEffective).toString()} effective (from prior runs)`);

  // Sanity: sumExpected ≈ depositRaw × myShare. Integer slack ≤ 1 per position.
  const expectedMyShare = (depositRaw * sumMyEffective) / totalEffective;
  const roundingSlack = BigInt(wallets.length);
  const diff = expectedMyShare > sumExpected ? expectedMyShare - sumExpected : sumExpected - expectedMyShare;
  if (diff > roundingSlack) {
    console.error(`FAIL sum(expected) ${sumExpected} vs depositRaw×myShare ${expectedMyShare} diff=${diff} > slack ${roundingSlack}`);
    process.exit(5);
  }

  // Claim from each wallet and assert observed ATA delta matches expected.
  console.log('\nClaiming from each wallet…');
  const results = [];
  for (const r of rows) {
    const { w, effective, expected } = r;
    const walletProvider = buildProvider(connection, w.kp);
    const walletProgram = loadProgram(walletProvider, programId);
    const checkpoint = findCheckpointPda(programId, w.position, rewardMintPda);
    // Create user reward ATA + claim.
    const userRewardAta = (await getOrCreateAssociatedTokenAccount(
      connection,
      w.kp,
      rewardMint,
      w.kp.publicKey,
      false,
      'confirmed',
      undefined,
      rewardTokenProgram,
    )).address;
    const before = BigInt((await getAccount(connection, userRewardAta, 'confirmed', rewardTokenProgram)).amount);
    const sig = await walletProgram.methods
      .claim()
      .accounts({
        pool,
        rewardMint: rewardMintPda,
        mint: rewardMint,
        vault: rewardVault,
        position: w.position,
        owner: w.kp.publicKey,
        checkpoint,
        userTokenAccount: userRewardAta,
        tokenProgram: rewardTokenProgram,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    const after = BigInt((await getAccount(connection, userRewardAta, 'confirmed', rewardTokenProgram)).amount);
    const delta = after - before;
    const shareOfDeposit = depositRaw > 0n ? Number(expected) / Number(depositRaw) : 0;
    const ok = delta === expected;
    results.push({ idx: w.idx, days: w.days, mult: w.multiplierBps, effective, expected, observed: delta, ok, sig, share: shareOfDeposit });
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log('\nResults:');
  console.log('idx | lockDays | mult | effective           | expected      | observed      | share   | ok');
  console.log('----+----------+------+---------------------+---------------+---------------+---------+----');
  let allOk = true;
  for (const r of results) {
    const row =
      `${String(r.idx).padStart(3)} | ` +
      `${String(r.days).padStart(8)} | ` +
      `${String(r.mult).padStart(4)} | ` +
      `${String(r.effective).padStart(19)} | ` +
      `${String(r.expected).padStart(13)} | ` +
      `${String(r.observed).padStart(13)} | ` +
      `${(r.share * 100).toFixed(2).padStart(6)}% | ` +
      `${r.ok ? 'PASS' : 'FAIL'}`;
    console.log(row);
    if (!r.ok) allOk = false;
  }

  const sumObserved = results.reduce((a, b) => a + b.observed, 0n);
  console.log('\nsum expected (my wallets) :', sumExpected.toString());
  console.log('sum observed (my wallets) :', sumObserved.toString());
  console.log('deposited (pool total)    :', depositRaw.toString());
  console.log(`my share of deposit       : ${(Number(sumExpected) / Number(depositRaw) * 100).toFixed(4)}%`);
  const myDiff = sumExpected > sumObserved ? sumExpected - sumObserved : sumObserved - sumExpected;
  console.log('observed-vs-expected diff :', myDiff.toString(), `(≤ ${roundingSlack} tolerated)`);

  if (!allOk) {
    console.error('\nFAIL: one or more claims did not match expected amount');
    process.exit(5);
  }
  if (myDiff > roundingSlack) {
    console.error('\nFAIL: too much rounding loss on my wallets');
    process.exit(5);
  }

  if (args.keepWallets) {
    console.log('\nTest wallets (retained for inspection):');
    for (const w of wallets) {
      console.log(`  [${w.idx}] ${w.kp.publicKey.toBase58()} secret=${Buffer.from(w.kp.secretKey).toString('base64')}`);
    }
  }

  console.log('\nPASS');
}

main().catch((e) => {
  console.error('\nFAIL', e.message || e);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
