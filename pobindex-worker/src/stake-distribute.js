'use strict';

/**
 * Deposits creator-fee rewards into the pob-index-stake pool (one call per
 * reward mint). Called by the worker instead of airdropping to holders when
 * POB_STAKE_DISTRIBUTE=1.
 *
 * Supports both legacy SPL and Token-2022 reward mints; the pool's staking
 * program now uses the token_interface and the reward-vault ATA is derived
 * with the mint's actual owning token program.
 */

const path = require('path');
const { PublicKey, Transaction, ComputeBudgetProgram } = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
} = require('@solana/spl-token');
const BN = require('bn.js');

const config = require('./config');

const SEEDS = {
  pool: Buffer.from('pool'),
  reward: Buffer.from('reward'),
};

function findPoolPda(programId, stakeMint) {
  return PublicKey.findProgramAddressSync(
    [SEEDS.pool, stakeMint.toBuffer()],
    programId,
  );
}

function findRewardMintPda(programId, pool, mint) {
  return PublicKey.findProgramAddressSync(
    [SEEDS.reward, pool.toBuffer(), mint.toBuffer()],
    programId,
  );
}

async function detectTokenProgram(connection, mint) {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`Mint ${mint.toBase58()} not found`);
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  throw new Error(`Mint ${mint.toBase58()} not owned by a token program`);
}

function resolveStakingConfig() {
  const programIdStr = process.env.POB_STAKE_PROGRAM_ID;
  const stakeMintStr = process.env.POB_STAKE_MINT;
  if (!programIdStr || !stakeMintStr) {
    return { enabled: false, configured: false };
  }
  let programId;
  let stakeMint;
  try {
    programId = new PublicKey(programIdStr);
    stakeMint = new PublicKey(stakeMintStr);
  } catch (e) {
    throw new Error(`Invalid POB_STAKE_PROGRAM_ID / POB_STAKE_MINT: ${e.message}`);
  }
  const [pool] = findPoolPda(programId, stakeMint);
  const enabled = String(process.env.POB_STAKE_DISTRIBUTE || '0') === '1';
  return { enabled, configured: true, programId, stakeMint, pool };
}

async function loadAnchorProgram(connection, signerKeypair, programId) {
  let anchor;
  try {
    anchor = require('@coral-xyz/anchor');
  } catch (e) {
    throw new Error(
      'Missing @coral-xyz/anchor dependency. Run `npm i @coral-xyz/anchor` in pobindex-worker.',
    );
  }
  const idlPath = path.join(__dirname, '..', '..', 'staking-sdk', 'src', 'idl.json');
  // eslint-disable-next-line import/no-dynamic-require, global-require
  const idl = require(idlPath);
  const customIdl = { ...idl, address: programId.toBase58() };

  const wallet = {
    publicKey: signerKeypair.publicKey,
    signTransaction: async (tx) => { tx.partialSign(signerKeypair); return tx; },
    signAllTransactions: async (txs) => txs.map((tx) => { tx.partialSign(signerKeypair); return tx; }),
  };
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
  const program = new anchor.Program(customIdl, provider);
  return { anchor, program };
}

/**
 * For each reward mint registered on the pool that matches one of the provided
 * creator-fee payouts, build a `deposit_rewards` instruction and send it.
 *
 * @param {object} opts
 * @param {import('@solana/web3.js').Keypair} opts.treasury
 * @param {Array<{ mint: string, amount: bigint | number }>} opts.payouts  raw base-unit amounts
 * @returns {Promise<{ deposited: Array, skipped: Array }>}
 */
async function depositCreatorFeesToPool({ treasury, payouts }) {
  const cfg = resolveStakingConfig();
  if (!cfg.enabled) return { deposited: [], skipped: payouts.map((p) => ({ ...p, reason: 'staking disabled' })) };

  const connection = config.stakeConnection;
  const { program } = await loadAnchorProgram(connection, treasury, cfg.programId);

  const pool = await program.account.stakePool.fetchNullable(cfg.pool);
  if (!pool) {
    return { deposited: [], skipped: payouts.map((p) => ({ ...p, reason: 'pool not initialized' })) };
  }
  if (pool.totalEffective && pool.totalEffective.isZero && pool.totalEffective.isZero()) {
    return { deposited: [], skipped: payouts.map((p) => ({ ...p, reason: 'pool has zero effective stake' })) };
  }

  const deposited = [];
  const skipped = [];

  for (const { mint, amount } of payouts) {
    try {
      const mintPk = new PublicKey(mint);
      const tokenProgram = await detectTokenProgram(connection, mintPk);
      const [rewardMintPda] = findRewardMintPda(cfg.programId, cfg.pool, mintPk);
      const rewardMintAcc = await program.account.rewardMint.fetchNullable(rewardMintPda);
      if (!rewardMintAcc) {
        skipped.push({ mint, amount, reason: 'reward mint not registered on pool (add_reward_mint required)' });
        continue;
      }
      const funderAta = getAssociatedTokenAddressSync(mintPk, treasury.publicKey, false, tokenProgram);
      let funderBalance = 0n;
      try {
        const acc = await getAccount(connection, funderAta, 'confirmed', tokenProgram);
        funderBalance = acc.amount;
      } catch {
        skipped.push({ mint, amount, reason: 'treasury has no ATA / zero balance for reward mint' });
        continue;
      }
      const raw = typeof amount === 'bigint' ? amount : BigInt(amount);
      if (raw <= 0n || funderBalance < raw) {
        skipped.push({ mint, amount: raw.toString(), reason: `insufficient balance (${funderBalance})` });
        continue;
      }

      const ix = await program.methods
        .depositRewards(new BN(raw.toString()))
        .accounts({
          pool: cfg.pool,
          rewardMint: rewardMintPda,
          mint: mintPk,
          vault: rewardMintAcc.vault,
          funder: treasury.publicKey,
          funderTokenAccount: funderAta,
          tokenProgram,
        })
        .instruction();

      const tx = new Transaction();
      if (config.ONE_TIME_PRIORITY_FEE) {
        tx.add(
          ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: Math.max(1, Math.round(config.ONE_TIME_PRIORITY_FEE * 1e6)),
          }),
        );
      }
      tx.add(ix);

      const sig = await program.provider.sendAndConfirm(tx, [treasury]);
      deposited.push({ mint, amount: raw.toString(), signature: sig });
    } catch (e) {
      skipped.push({ mint, amount, reason: e.message || String(e) });
    }
  }

  return { deposited, skipped };
}

/**
 * Lightweight pool-state reader for dashboard use. Returns null when staking
 * is not configured, so callers can silently skip.
 */
async function fetchPoolStateForDashboard() {
  const cfg = resolveStakingConfig();
  if (!cfg.programId || !cfg.stakeMint) return null;
  const connection = config.stakeConnection;
  // We just need a read-only provider; use a dummy signer (we never send).
  const anchor = require('@coral-xyz/anchor');
  const { Keypair } = require('@solana/web3.js');
  const readSigner = Keypair.generate();
  const { program } = await loadAnchorProgram(connection, readSigner, cfg.programId);

  const pool = await program.account.stakePool.fetchNullable(cfg.pool);
  if (!pool) {
    return {
      programId: cfg.programId.toBase58(),
      stakeMint: cfg.stakeMint.toBase58(),
      pool: cfg.pool.toBase58(),
      initialized: false,
    };
  }

  let stakeDecimals = 9;
  try {
    const { getMint } = require('@solana/spl-token');
    const mintInfo = await getMint(connection, cfg.stakeMint);
    stakeDecimals = mintInfo.decimals;
  } catch (_) { /* keep default */ }

  return {
    programId: cfg.programId.toBase58(),
    stakeMint: cfg.stakeMint.toBase58(),
    pool: cfg.pool.toBase58(),
    initialized: true,
    totalStaked: pool.totalStaked?.toString?.() || '0',
    totalEffective: pool.totalEffective?.toString?.() || '0',
    rewardMintCount: typeof pool.rewardMintCount === 'number' ? pool.rewardMintCount : (pool.rewardMintCount?.toNumber?.() ?? null),
    stakeDecimals,
  };
}

module.exports = {
  resolveStakingConfig,
  depositCreatorFeesToPool,
  fetchPoolStateForDashboard,
  findPoolPda,
  findRewardMintPda,
  detectTokenProgram,
};
