#!/usr/bin/env node
'use strict';

/**
 * Distribute the POB500 presale allocation by staking each contributor's
 * pro-rata share on-chain with `stake_for` (treasury signs, contributor's
 * wallet is `position.owner`).
 *
 * Safety:
 *   - Defaults to a dry-run. Must pass `--live` to actually send txs.
 *   - Refuses to run if the stake cluster (`STAKE_RPC_URL`) is devnet while
 *     we'd be charging treasury for 100+ tx fees on mainnet-esque contribs
 *     — pass `--i-really-mean-it` to override (only useful for devnet drills).
 *   - Idempotent: tracks sent distributions in `data/presale/distributed.json`.
 *     Safe to re-run if interrupted.
 *
 * Usage:
 *   npm run presale:distribute -- --dry-run            # default
 *   npm run presale:distribute -- --live               # ship it
 *   npm run presale:distribute -- --live --limit 20    # batch in chunks
 *   npm run presale:distribute -- --only <WALLET>      # one wallet
 */

const path = require('path');
const fs = require('fs');
const {
  PublicKey,
  Keypair,
  Transaction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
} = require('@solana/spl-token');
const BN = require('bn.js');

const config = require('../src/config');
const {
  resolvePresaleConfig,
  loadContributions,
  loadDistributed,
  saveDistributed,
  allocateAllocations,
  formatSol,
  formatTokens,
} = require('../src/presale');

const SDK_IDL_PATH = path.join(__dirname, '..', '..', 'staking-sdk', 'src', 'idl.json');
const TX_PACKET_BUDGET = 1200; // Solana's hard cap is 1232; keep headroom for sig.

function parseArgs(argv) {
  const args = {
    live: false,
    dryRun: true,
    only: null,
    limit: null,
    start: 0,
    iReallyMeanIt: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') { args.live = true; args.dryRun = false; }
    else if (a === '--dry-run') { args.dryRun = true; args.live = false; }
    else if (a === '--only') args.only = argv[++i];
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (a === '--start') args.start = parseInt(argv[++i], 10);
    else if (a === '--i-really-mean-it') args.iReallyMeanIt = true;
  }
  return args;
}

function loadIdl(programId) {
  const idl = JSON.parse(fs.readFileSync(SDK_IDL_PATH, 'utf8'));
  return { ...idl, address: programId.toBase58() };
}

async function detectTokenProgram(connection, mint) {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`Mint ${mint.toBase58()} not found`);
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  throw new Error(`Mint ${mint.toBase58()} not owned by a token program`);
}

function findPoolPda(programId, stakeMint) {
  return PublicKey.findProgramAddressSync([Buffer.from('pool'), stakeMint.toBuffer()], programId)[0];
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

/**
 * Pack a list of instructions into the fewest possible transactions that each
 * fit under `TX_PACKET_BUDGET`, given the provided fee-payer + recent blockhash.
 * Requires the anchor-style instruction order to be preserved. Returns an
 * array of `Transaction` objects.
 */
function packIxs(ixs, feePayer, recentBlockhash, priorityFeeIx) {
  const txs = [];
  let current = new Transaction();
  current.feePayer = feePayer;
  current.recentBlockhash = recentBlockhash;
  if (priorityFeeIx) current.add(priorityFeeIx);

  const trySerialize = (tx) => {
    try {
      return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
    } catch (e) {
      return Infinity;
    }
  };

  for (const ix of ixs) {
    current.add(ix);
    const size = trySerialize(current);
    if (size > TX_PACKET_BUDGET) {
      // Roll back: create a new tx starting with this ix.
      current.instructions.pop();
      if (current.instructions.length === (priorityFeeIx ? 1 : 0)) {
        throw new Error(`Instruction too large to fit a single tx (size=${size})`);
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

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const args = parseArgs(process.argv);
  const cfg = resolvePresaleConfig();

  const programIdStr = config.requireEnv('POB_STAKE_PROGRAM_ID');
  const stakeMintStr = config.requireEnv('POB_STAKE_MINT');
  const programId = new PublicKey(programIdStr);
  const stakeMint = new PublicKey(stakeMintStr);

  const treasury = config.parsePrivateKey(config.requireEnv('TREASURY_PRIVATE_KEY'));
  const connection = config.stakeConnection;

  const cluster = config.STAKE_RPC_URL;
  const isDevnet = /devnet|localhost|127\.0\.0\.1/i.test(cluster);

  console.log('— POB500 presale distribute —');
  console.log('  stake cluster :', cluster);
  console.log('  program       :', programId.toBase58());
  console.log('  stake mint    :', stakeMint.toBase58());
  console.log('  treasury      :', treasury.publicKey.toBase58());
  console.log('  lock days     :', cfg.lockDays);
  console.log('  mode          :', args.live ? 'LIVE' : 'dry-run');
  if (!isDevnet && !args.iReallyMeanIt && args.live) {
    console.log('  (mainnet-safe check passed)');
  }

  const contribs = loadContributions();
  if (!contribs) {
    console.error('No contributions file. Run `npm run presale:scan` first.');
    process.exit(1);
  }

  const allocations = allocateAllocations(contribs.contributors, cfg.tokenTotal);
  const distState = loadDistributed();

  const stakeTokenProgram = await detectTokenProgram(connection, stakeMint);
  const pool = findPoolPda(programId, stakeMint);
  const stakeVault = getAssociatedTokenAddressSync(stakeMint, pool, true, stakeTokenProgram);
  const treasuryAta = getAssociatedTokenAddressSync(stakeMint, treasury.publicKey, false, stakeTokenProgram);

  const anchor = require('@coral-xyz/anchor');
  const wallet = {
    publicKey: treasury.publicKey,
    signTransaction: async (tx) => { tx.partialSign(treasury); return tx; },
    signAllTransactions: async (txs) => txs.map((tx) => { tx.partialSign(treasury); return tx; }),
  };
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
  const program = new anchor.Program(loadIdl(programId), provider);

  // Sanity checks.
  const poolAcc = await program.account.stakePool.fetchNullable(pool);
  if (!poolAcc) throw new Error('Pool not initialized — run `npm run stake:init` first');
  if (poolAcc.paused) throw new Error('Pool is paused — admin must unpause before distribution');

  const treasuryBalance = await getAccount(connection, treasuryAta, 'confirmed', stakeTokenProgram)
    .catch(() => null);
  if (!treasuryBalance) {
    throw new Error(`Treasury POB500 ATA ${treasuryAta.toBase58()} does not exist. Buy presale supply first.`);
  }
  const treasuryTokens = BigInt(treasuryBalance.amount.toString());

  const rewardMints = await program.account.rewardMint.all([
    { memcmp: { offset: 8 + 1, bytes: pool.toBase58() } },
  ]);
  console.log('  reward mints  :', rewardMints.length);
  console.log('  treasury tokens:', treasuryTokens.toString());
  console.log('');

  const pending = allocations.filter((a) => !distState.entries[a.wallet] && (!args.only || a.wallet === args.only));
  const slice = pending.slice(args.start, args.limit ? args.start + args.limit : undefined);

  const totalNeeded = slice.reduce((acc, a) => acc + a.tokens, 0n);
  if (totalNeeded > treasuryTokens) {
    console.error(`Treasury short on POB500: needs ${totalNeeded} raw units, has ${treasuryTokens}`);
    process.exit(3);
  }

  const decimals = poolAcc.stakeMintDecimals ?? null;
  let stakeDecimals = decimals;
  if (stakeDecimals == null) {
    const mintInfo = await connection.getParsedAccountInfo(stakeMint);
    stakeDecimals = mintInfo?.value?.data?.parsed?.info?.decimals ?? 0;
  }

  console.log(`Processing ${slice.length} contributor(s) …`);
  console.log('');

  const priorityFeeMicroLamports = Math.max(
    1,
    Math.round((config.ONE_TIME_PRIORITY_FEE || 0.000001) * 1e9 * 1000),
  );

  let okCount = 0;
  let failCount = 0;

  for (const alloc of slice) {
    if (alloc.tokens === 0n) continue;
    const beneficiary = new PublicKey(alloc.wallet);
    const nonce = BigInt(Math.floor(Date.now() / 1000)) * 1000n + BigInt(okCount + failCount);
    const position = findPositionPda(programId, pool, beneficiary, nonce);

    const ixs = [];

    ixs.push(
      await program.methods
        .stakeFor(new BN(alloc.tokens.toString()), cfg.lockDays, new BN(nonce.toString()), beneficiary)
        .accounts({
          pool,
          stakeMint,
          stakeVault,
          payer: treasury.publicKey,
          payerTokenAccount: treasuryAta,
          position,
          tokenProgram: stakeTokenProgram,
          systemProgram: new PublicKey('11111111111111111111111111111111'),
          rent: new PublicKey('SysvarRent111111111111111111111111111111111'),
        })
        .instruction(),
    );

    for (const rm of rewardMints) {
      ixs.push(
        await program.methods
          .primeCheckpoint()
          .accounts({
            pool,
            rewardMint: rm.publicKey,
            position,
            checkpoint: findCheckpointPda(programId, position, rm.publicKey),
            payer: treasury.publicKey,
            systemProgram: new PublicKey('11111111111111111111111111111111'),
            rent: new PublicKey('SysvarRent111111111111111111111111111111111'),
          })
          .instruction(),
      );
    }

    console.log(
      `· ${alloc.wallet}  →  ${formatTokens(alloc.tokens, stakeDecimals)} POB500  (${formatSol(alloc.lamports.toString())} SOL in, ${(alloc.shareBps / 100).toFixed(2)}%)`,
    );

    if (args.dryRun) {
      console.log(`    dry-run: would stake position ${position.toBase58()} with nonce ${nonce}, ${ixs.length - 1} prime ix(s)`);
      okCount += 1;
      continue;
    }

    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const priorityIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports });
      const txs = packIxs(ixs, treasury.publicKey, blockhash, priorityIx);
      console.log(`    packed into ${txs.length} tx(s)`);

      const signatures = [];
      for (let t = 0; t < txs.length; t++) {
        const tx = txs[t];
        tx.lastValidBlockHeight = lastValidBlockHeight;
        const sig = await sendAndConfirmTransaction(connection, tx, [treasury], {
          commitment: 'confirmed',
          skipPreflight: false,
        });
        signatures.push(sig);
        console.log(`    tx ${t + 1}/${txs.length}: ${sig}`);
      }

      distState.entries[alloc.wallet] = {
        position: position.toBase58(),
        nonce: nonce.toString(),
        tokensRaw: alloc.tokens.toString(),
        lamportsIn: alloc.lamports.toString(),
        shareBps: alloc.shareBps,
        lockDays: cfg.lockDays,
        signatures,
        primedMints: rewardMints.map((rm) => rm.account.mint.toBase58()),
        stakedAt: new Date().toISOString(),
      };
      saveDistributed(distState);
      okCount += 1;
      await sleep(300); // be nice to RPC
    } catch (e) {
      failCount += 1;
      console.error(`    ERROR: ${e.message}`);
      if (e.logs) console.error(e.logs.slice(0, 12).join('\n'));
    }
  }

  console.log('');
  console.log('Summary:', {
    processed: slice.length,
    ok: okCount,
    failed: failCount,
    skipped_already_done: allocations.length - pending.length,
    mode: args.live ? 'LIVE' : 'dry-run',
  });
  if (args.dryRun) {
    console.log('\nNothing was sent. Re-run with --live to broadcast.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
